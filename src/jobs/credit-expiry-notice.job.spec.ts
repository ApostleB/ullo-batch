/**
 * 크레딧 만료 15일 전 사전 안내 잡 — 대상 식별, 멱등, 지나친 D-15 catch-up, 게이트, 알림 실패 격리.
 * DB 는 인메모리 가짜(실제 DB·다날 호출 없음)이고, 가짜 DB 의 후보 조회는 잡이 넘긴 날짜 파라미터로 SQL 의 조건을 그대로 흉내 낸다.
 */
import 'reflect-metadata';

const mockConfig = { env: 'local', nodeEnv: 'local', creditExpiry: { noticeEnabled: true } };
jest.mock('../config', () => ({ config: mockConfig }));

type Row = Record<string, any>;
const { MemberNotification } = require('../entities/member-notification.entity');

class FakeDb {
  /** member_credit lot + 조인될 구독 상태·회원 탈퇴 여부를 평탄화한 행 */
  lots: Row[] = [];
  notifications: Row[] = [];
  failInsert = false;
  queries: { sql: string; params: any[] }[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  private build(): any {
    const mgr: any = {
      query: async (sql: string, params: any[] = []) => {
        this.queries.push({ sql, params });
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('FROM member_notification')) {
          const [memberId, link] = params;
          return this.notifications.filter((n) => n.member_id === memberId && n.category === 'KAKAO_STUB' && n.link === link).map(() => ({ one: 1 }));
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      insert: async (E: any, row: Row) => {
        if (E !== MemberNotification) throw new Error('unknown entity');
        if (this.failInsert) throw new Error('알림 insert 실패(주입)');
        this.notifications.push({ ...row });
        return {};
      },
      transaction: async (cb: (m: any) => Promise<any>) => {
        const snap = structuredClone(this.notifications);
        try {
          return await cb(mgr);
        } catch (err) {
          this.notifications = snap;
          throw err;
        }
      },
    };
    return mgr;
  }
  manager = this.build();

  /** 후보 조회 — SQL 조건(SUBSCRIPTION 지급분·해지된 구독·미탈퇴·잔여>0·만료일 범위·회원 한정)을 흉내 낸다 */
  async query(sql: string, params: any[]) {
    this.queries.push({ sql, params });
    // 회원 한정(--member)이 있으면 $3 이 회원, 없으면 $3 이 활성 정지 판단 시각이다
    const scoped = sql.includes('mc.member_id = $3');
    const [from, to, third, fourth] = params as [string, string, string, string | undefined];
    const only = scoped ? third : undefined;
    const suspensionAt = scoped ? fourth : third; // 'YYYY-MM-DD HH:mm:ss' 로컬 시각 — 활성 정지 판단 기준
    void suspensionAt;
    const groups = new Map<string, Row>();
    for (const l of this.lots) {
      if (l.credit_type !== 'SUBSCRIPTION' || l.is_del !== 'N' || !(l.credit > 0)) continue;
      if (l.plan_status !== 'CANCELED' || l.plan_is_del !== 'N' || l.member_is_del !== 'N') continue;
      if (l.member_suspended) continue; // NOT EXISTS (활성 정지) — 정지 회원은 로그인할 수 없어 안내 대상이 아니다
      if (l.end_dt < from || l.end_dt > to) continue;
      if (only && l.member_id !== only) continue;
      const k = `${l.member_id}|${l.end_dt}`;
      const g = groups.get(k) ?? { member_id: l.member_id, end_dt: l.end_dt, remaining: 0 };
      g.remaining += l.credit;
      groups.set(k, g);
    }
    return [...groups.values()];
  }
  transaction = (cb: (m: any) => Promise<any>) => {
    const run = this.chain.then(() => cb(this.manager));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  };
}

const mockDb = new FakeDb();
jest.mock('../db/data-source', () => ({ AppDataSource: mockDb }));

import { execute } from './credit-expiry-notice.job';
import { setAsOfDate } from '../utils/date.util';
import { resetTestOptions, setTestOptions } from '../utils/test-options';

const log: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const lot = (over: Row = {}): Row => ({
  member_id: 'm1',
  credit_type: 'SUBSCRIPTION',
  credit: 10,
  end_dt: '2026-12-03',
  is_del: 'N',
  plan_status: 'CANCELED',
  plan_is_del: 'N',
  member_is_del: 'N',
  ...over,
});
const setToday = (y: number, m: number, d: number) => jest.setSystemTime(new Date(y, m - 1, d, 10, 0, 0));
const links = () => mockDb.notifications.map((n) => `${n.member_id} ${n.link}`);

beforeEach(() => {
  jest.useFakeTimers({
    now: new Date(2026, 10, 18, 10, 0, 0), // 2026-11-18 — D+15 = 2026-12-03
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
  jest.clearAllMocks();
  mockConfig.creditExpiry.noticeEnabled = true;
  mockDb.lots = [];
  mockDb.notifications = [];
  mockDb.failInsert = false;
  mockDb.queries = [];
  resetTestOptions();
});
afterEach(() => {
  jest.useRealTimers();
  setAsOfDate(null);
});

describe('운영 게이트', () => {
  it('CREDIT_EXPIRY_NOTICE_ENABLED 가 꺼져 있으면 DB 조회도 기록도 하지 않는다', async () => {
    mockConfig.creditExpiry.noticeEnabled = false;
    mockDb.lots = [lot()];
    await execute(log);
    expect(mockDb.queries).toHaveLength(0);
    expect(mockDb.notifications).toHaveLength(0);
  });
});

describe('대상 식별', () => {
  it('해지된 구독의 SUBSCRIPTION 지급 크레딧 중 만료일이 오늘 + 15일인 잔여분을 회원·만료일 묶음으로 합산해 1건 기록한다', async () => {
    mockDb.lots = [lot({ credit: 6 }), lot({ credit: 4 })];
    await execute(log);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.notifications[0]).toMatchObject({
      member_id: 'm1',
      category: 'KAKAO_STUB',
      title: '크레딧 만료가 다가왔어요',
      link: 'credit-expiry?end_dt=2026-12-03',
      is_read: 'N',
      is_del: 'N',
    });
    expect(mockDb.notifications[0].body).toContain('크레딧 10개');
    expect(mockDb.notifications[0].body).toContain('2026-12-03');
    expect(mockDb.notifications[0].body).toContain('15일 남음');
  });

  it.each([
    ['구독이 아직 활성(해지 아님)', { plan_status: 'ACTIVE' }],
    ['구독 지급분이 아님(쿠폰·일회성 크레딧)', { credit_type: 'COUPON' }],
    ['잔여 크레딧 0', { credit: 0 }],
    ['삭제된 lot', { is_del: 'Y' }],
    ['탈퇴한 회원', { member_is_del: 'Y' }],
    ['삭제된 구독 행', { plan_is_del: 'Y' }],
  ])('%s 은 대상이 아니다', async (_n, over) => {
    mockDb.lots = [lot(over)];
    await execute(log);
    expect(mockDb.notifications).toHaveLength(0);
  });

  it.each([
    ['만료일이 16일 뒤(아직 이름)', '2026-12-04'],
    ['만료일이 오늘(이미 만료일 당일)', '2026-11-18'],
    ['이미 지난 만료일', '2026-11-10'],
  ])('%s → 대상 아님', async (_n, end_dt) => {
    mockDb.lots = [lot({ end_dt })];
    await execute(log);
    expect(mockDb.notifications).toHaveLength(0);
  });

  it('만료일이 다른 묶음은 따로 안내한다', async () => {
    mockDb.lots = [lot({ end_dt: '2026-12-03' }), lot({ end_dt: '2026-12-01', credit: 3 })];
    await execute(log);
    expect(links().sort()).toEqual(['m1 credit-expiry?end_dt=2026-12-01', 'm1 credit-expiry?end_dt=2026-12-03']);
  });

  it('회원이 여럿이면 각각 안내한다', async () => {
    mockDb.lots = [lot({ member_id: 'm1' }), lot({ member_id: 'm2' })];
    await execute(log);
    expect(mockDb.notifications.map((n) => n.member_id).sort()).toEqual(['m1', 'm2']);
  });

  it('날짜는 로컬(KST) 문자열 YYYY-MM-DD 로 조회한다(월·연 경계)', async () => {
    setToday(2026, 12, 20); // +15 = 2027-01-04
    mockDb.lots = [lot({ end_dt: '2027-01-04' })];
    await execute(log);
    expect(mockDb.queries[0].params.slice(0, 2)).toEqual(['2026-12-21', '2027-01-04']);
    expect(mockDb.notifications).toHaveLength(1);
  });
});

describe('후보 조회 SQL (가짜 DB 는 SQL 을 실행하지 않으므로 핵심 조건을 문자열로 고정한다)', () => {
  it('구독 지급분·해지된 구독·미탈퇴·잔여>0 조건과 date 컬럼 문자열 변환을 쓴다', async () => {
    await execute(log);
    const sql = mockDb.queries[0].sql;
    expect(sql).toContain("mc.credit_type = 'SUBSCRIPTION'");
    expect(sql).toContain('mp.member_plan_id = mc.member_membership_id');
    expect(sql).toContain("mp.status = 'CANCELED'");
    expect(sql).toContain("m.is_del = 'N'");
    expect(sql).toContain('mc.credit > 0');
    expect(sql).toContain("to_char(mc.end_dt, 'YYYY-MM-DD')");
    expect(sql).not.toContain('mc.member_id = $3'); // --member 가 없으면 회원 한정 조건이 없다
  });

  it('[참고] 활성 정지 회원을 빼는 조건(백엔드 MemberSuspensionHelper 와 같은 released_at IS NULL AND (end_at IS NULL OR end_at > 지금))을 쓴다', async () => {
    await execute(log);
    const { sql, params } = mockDb.queries[0];
    expect(sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM member_suspension ms/);
    expect(sql).toContain('ms.member_id = mc.member_id');
    expect(sql).toContain('ms.released_at IS NULL');
    expect(sql).toMatch(/ms\.end_at IS NULL OR ms\.end_at > \$3/);
    expect(params[2]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/); // 로컬 시각 문자열
  });
});

describe('활성 정지 회원 제외 [참고]', () => {
  it('활성 정지 회원의 해지 구독 크레딧은 안내하지 않고, 정지가 아닌 회원은 안내한다', async () => {
    mockDb.lots = [lot({ member_id: 'm-suspended', member_suspended: true }), lot({ member_id: 'm-ok' })];
    await execute(log);
    expect(mockDb.notifications.map((n) => n.member_id)).toEqual(['m-ok']);
  });

  it('--member 로 한정해도 정지 회원이면 안내하지 않는다', async () => {
    setTestOptions({ memberId: 'm-suspended' });
    mockDb.lots = [lot({ member_id: 'm-suspended', member_suspended: true })];
    await execute(log);
    expect(mockDb.notifications).toHaveLength(0);
  });
});

describe('멱등 — 같은 회원·같은 만료 묶음은 1회만', () => {
  it('하루에 두 번 실행해도 1건', async () => {
    mockDb.lots = [lot()];
    await execute(log);
    await execute(log);
    expect(mockDb.notifications).toHaveLength(1);
  });

  it('다음 날 실행해도(D-14) 이미 안내한 묶음은 다시 보내지 않는다', async () => {
    mockDb.lots = [lot()];
    await execute(log);
    setToday(2026, 11, 19);
    await execute(log);
    expect(mockDb.notifications).toHaveLength(1);
  });

  it('동시에 두 번 실행돼도 1건(직렬화된 락 + 존재 확인)', async () => {
    mockDb.lots = [lot()];
    await Promise.all([execute(log), execute(log)]);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.queries.some((q) => q.sql.includes('pg_advisory_xact_lock'))).toBe(true);
  });
});

describe('배치가 못 돈 날(D-15 를 지나침)', () => {
  it('D-14~D-1 사이에서 아직 안내하지 않은 건을 1회 보낸다', async () => {
    mockDb.lots = [lot({ end_dt: '2026-12-03' })];
    setToday(2026, 11, 25); // 만료까지 8일 — 15일 전을 놓침
    await execute(log);
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.notifications[0].body).toContain('8일 남음');
    setToday(2026, 11, 26);
    await execute(log);
    expect(mockDb.notifications).toHaveLength(1);
  });

  it('만료 하루 전(D-1)까지 보낸다', async () => {
    mockDb.lots = [lot({ end_dt: '2026-12-03' })];
    setToday(2026, 12, 2);
    await execute(log);
    expect(mockDb.notifications).toHaveLength(1);
  });

  it('구독을 해지한 시점에 이미 만료 임박(D-10)이어도 다음 실행에서 1회 안내한다', async () => {
    mockDb.lots = [lot({ end_dt: '2026-11-28', plan_status: 'ACTIVE' })];
    await execute(log);
    expect(mockDb.notifications).toHaveLength(0);
    mockDb.lots[0].plan_status = 'CANCELED';
    await execute(log);
    expect(mockDb.notifications).toHaveLength(1);
  });
});

describe('알림 기록 실패', () => {
  it('insert 가 실패해도 잡은 끝까지 돌고(예외 없음), 실패한 건은 기록되지 않아 다음 실행에서 다시 시도된다', async () => {
    mockDb.lots = [lot({ member_id: 'm1' }), lot({ member_id: 'm2' })];
    mockDb.failInsert = true;
    await expect(execute(log)).resolves.toBeUndefined();
    expect(mockDb.notifications).toHaveLength(0);
    expect(JSON.stringify(log.error.mock.calls)).toContain('NOTIFY_FAILED');
    mockDb.failInsert = false;
    await execute(log);
    expect(mockDb.notifications).toHaveLength(2);
  });

  it('한 건에서 예외가 나도 다른 회원은 계속 처리한다', async () => {
    mockDb.lots = [lot({ member_id: 'm1' }), lot({ member_id: 'm2' })];
    const real = mockDb.manager.query;
    let n = 0;
    jest.spyOn(mockDb.manager, 'query').mockImplementation((async (sql: string, params: any[]) => {
      if (sql.includes('FROM member_notification') && n++ === 0) throw new Error('db down');
      return real(sql, params);
    }) as any);
    await execute(log);
    expect(mockDb.notifications).toHaveLength(1);
    expect(log.error).toHaveBeenCalled();
  });
});

describe('재현 옵션 --as-of / --member', () => {
  it('--as-of 날짜를 오늘로 쓴다', async () => {
    setTestOptions({ asOf: '2026-11-25' });
    mockDb.lots = [lot({ end_dt: '2026-12-10' })];
    await execute(log);
    expect(mockDb.queries[0].params.slice(0, 2)).toEqual(['2026-11-26', '2026-12-10']);
    expect(mockDb.notifications).toHaveLength(1);
  });

  it('--member 는 그 회원만 대상으로 한다', async () => {
    setTestOptions({ memberId: 'm2' });
    mockDb.lots = [lot({ member_id: 'm1' }), lot({ member_id: 'm2' })];
    await execute(log);
    expect(mockDb.notifications.map((n) => n.member_id)).toEqual(['m2']);
  });
});
