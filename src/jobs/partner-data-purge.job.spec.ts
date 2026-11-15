/**
 * 파트너 W10 데이터 보존 기간 파기(partner-data-purge) — 게이트, 1,000행 배치 반복, 읽음 행 선삭제, 테이블 없음 처리.
 * DB 는 SQL 문자열로 분기하는 가짜 QueryRunner(실제 DB 호출 없음)다. 보존 기간 조건은 SQL 문자열로 고정한다.
 */
const mockConfig = { partnerDataPurge: { enabled: true } };
jest.mock('../config', () => ({ config: mockConfig }));

class FakeRunner {
  /** 테이블 존재 여부(to_regclass) */
  present = new Set(['partner_activity_log', 'partner_notification', 'partner_notification_read', 'partner_password_reset']);
  /** 보존 기간이 지난 행 수 */
  oldActivity = 0;
  oldReset = 0;
  /** 보존 기간이 지난 알림 ID 와 각 알림의 읽음 행 수 */
  oldNotifications: string[] = [];
  reads = new Map<string, number>();
  /** 실행 순서 기록 */
  events: string[] = [];
  calls: { sql: string; params: unknown[]; structured?: boolean }[] = [];
  inTx = false;
  committed = 0;
  rolledBack = 0;
  released = 0;
  failOn?: string;

  async query(sql: string, params: unknown[], structured?: boolean) {
    this.calls.push({ sql, params, structured });
    if (this.failOn && sql.includes(this.failOn)) throw new Error(`주입 실패: ${this.failOn}`);
    if (sql.includes('to_regclass')) {
      return { records: (params[0] as string[]).filter((n) => this.present.has(n)).map((name) => ({ name })) };
    }
    if (sql.startsWith('DELETE FROM partner_activity_log')) {
      const n = Math.min(this.oldActivity, params[0] as number);
      this.oldActivity -= n;
      this.events.push(`activity:${n}`);
      return { records: [], affected: n };
    }
    if (sql.startsWith('DELETE FROM partner_password_reset')) {
      const n = Math.min(this.oldReset, params[0] as number);
      this.oldReset -= n;
      this.events.push(`reset:${n}`);
      return { records: [], affected: n };
    }
    if (sql.startsWith('SELECT partner_notification_id FROM partner_notification')) {
      expect(this.inTx).toBe(true);
      const ids = this.oldNotifications.slice(0, params[0] as number);
      this.events.push(`select:${ids.length}`);
      return { records: ids.map((partner_notification_id) => ({ partner_notification_id })) };
    }
    if (sql.startsWith('DELETE FROM partner_notification_read')) {
      expect(this.inTx).toBe(true);
      const ids = params[0] as string[];
      let n = 0;
      for (const id of ids) {
        n += this.reads.get(id) ?? 0;
        this.reads.delete(id);
      }
      this.events.push(`read:${n}`);
      return { records: [], affected: n };
    }
    if (sql.startsWith('DELETE FROM partner_notification ')) {
      expect(this.inTx).toBe(true);
      const ids = new Set(params[0] as string[]);
      const before = this.oldNotifications.length;
      this.oldNotifications = this.oldNotifications.filter((id) => !ids.has(id));
      const n = before - this.oldNotifications.length;
      this.events.push(`notification:${n}`);
      return { records: [], affected: n };
    }
    throw new Error(`unexpected sql: ${sql}`);
  }
  async startTransaction() {
    this.inTx = true;
  }
  async commitTransaction() {
    this.inTx = false;
    this.committed++;
  }
  async rollbackTransaction() {
    this.inTx = false;
    this.rolledBack++;
  }
  async release() {
    this.released++;
  }
}

let fake: FakeRunner;
const createQueryRunner = jest.fn(() => fake);
jest.mock('../db/data-source', () => ({ AppDataSource: { createQueryRunner: () => createQueryRunner() } }));

import { execute, JOB_NAME, BATCH_SIZE, SQL, ALL_TABLES } from './partner-data-purge.job';

const log: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const infoText = () => log.info.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.partnerDataPurge.enabled = true;
  fake = new FakeRunner();
});

describe('partner-data-purge — 게이트', () => {
  it('PARTNER_DATA_PURGE_ENABLED 가 꺼져 있으면 DB 에 연결하지도 조회하지도 않는다', async () => {
    mockConfig.partnerDataPurge.enabled = false;
    fake.oldActivity = 5;

    await execute(log);

    expect(createQueryRunner).not.toHaveBeenCalled();
    expect(fake.calls).toHaveLength(0);
    expect(fake.oldActivity).toBe(5);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('PARTNER_DATA_PURGE_ENABLED'));
  });

  it("게이트는 환경변수가 정확히 'true' 일 때만 켜진다(config 해석)", () => {
    const cases: Array<[string | undefined, boolean]> = [
      [undefined, false],
      ['', false],
      ['TRUE', false],
      ['1', false],
      ['true', true],
    ];
    const prev = process.env.PARTNER_DATA_PURGE_ENABLED;
    try {
      for (const [v, want] of cases) {
        if (v === undefined) delete process.env.PARTNER_DATA_PURGE_ENABLED;
        else process.env.PARTNER_DATA_PURGE_ENABLED = v;
        jest.isolateModules(() => {
          const real = jest.requireActual('../config') as typeof import('../config');
          expect(real.config.partnerDataPurge.enabled).toBe(want);
        });
      }
    } finally {
      if (prev === undefined) delete process.env.PARTNER_DATA_PURGE_ENABLED;
      else process.env.PARTNER_DATA_PURGE_ENABLED = prev;
    }
  });

  it('cron 기본값은 매일 04:30 이다', () => {
    const prev = process.env.JOB_PARTNER_DATA_PURGE_CRON;
    delete process.env.JOB_PARTNER_DATA_PURGE_CRON;
    try {
      jest.isolateModules(() => {
        const real = jest.requireActual('../config') as typeof import('../config');
        expect(real.config.jobs.partnerDataPurge.cron).toBe('30 4 * * *');
      });
    } finally {
      if (prev !== undefined) process.env.JOB_PARTNER_DATA_PURGE_CRON = prev;
    }
  });
});

describe('partner-data-purge — 보존 기간 SQL', () => {
  it('보존 기간(DQ-5)과 1,000행 제한을 SQL 에 고정한다', () => {
    expect(BATCH_SIZE).toBe(1000);
    expect(SQL.activityLog).toContain(`created_at < now() - interval '1 year'`);
    expect(SQL.notificationIds).toContain(`created_at < now() - interval '180 days'`);
    expect(SQL.passwordReset).toContain(`created_at < now() - interval '30 days'`);
    for (const sql of [SQL.activityLog, SQL.notificationIds, SQL.passwordReset]) expect(sql).toContain('LIMIT $1');
    expect(SQL.notificationRead).toBe(`DELETE FROM partner_notification_read WHERE partner_notification_id = ANY($1::uuid[])`);
    expect(SQL.notification).toBe(`DELETE FROM partner_notification WHERE partner_notification_id = ANY($1::uuid[])`);
  });

  it('삭제는 LIMIT $1 에 BATCH_SIZE 를 넘기고 structured result 로 건수를 받는다', async () => {
    fake.oldActivity = 3;
    await execute(log);
    const call = fake.calls.find((c) => c.sql === SQL.activityLog)!;
    expect(call.params).toEqual([BATCH_SIZE]);
    expect(call.structured).toBe(true);
  });
});

describe('partner-data-purge — 배치 반복', () => {
  it('1,000행씩 반복해 남은 행이 1,000 미만인 배치에서 멈춘다', async () => {
    fake.oldActivity = 2500;
    fake.oldReset = 1000;

    await execute(log);

    expect(fake.events.filter((e) => e.startsWith('activity'))).toEqual(['activity:1000', 'activity:1000', 'activity:500']);
    // 정확히 1,000건이면 한 번 더 돌아 0건을 확인하고 멈춘다
    expect(fake.events.filter((e) => e.startsWith('reset'))).toEqual(['reset:1000', 'reset:0']);
    expect(fake.oldActivity).toBe(0);
    expect(fake.oldReset).toBe(0);
    expect(infoText()).toContain('활동 로그(1년) 2500건');
    expect(infoText()).toContain('비밀번호 재설정 기록(30일) 1000건');
  });

  it('지울 행이 없으면 대상마다 한 번만 조회하고 0건으로 끝낸다', async () => {
    await execute(log);

    expect(fake.events).toEqual(['activity:0', 'select:0', 'reset:0']);
    expect(infoText()).toContain('활동 로그(1년) 0건, 알림(180일) 0건(읽음 0건), 비밀번호 재설정 기록(30일) 0건');
    expect(fake.released).toBe(1);
  });

  it('알림은 1,000건씩 골라 배치마다 커밋한다', async () => {
    fake.oldNotifications = Array.from({ length: 2300 }, (_, i) => `n${i}`);

    await execute(log);

    expect(fake.events.filter((e) => e.startsWith('notification'))).toEqual([
      'notification:1000',
      'notification:1000',
      'notification:300',
    ]);
    expect(fake.committed).toBe(3);
    expect(fake.oldNotifications).toHaveLength(0);
  });

  it('한 실행 최대 배치 수에 도달하면 경고하고 멈춘다(무한 반복 방지)', async () => {
    const { MAX_BATCHES_PER_TARGET } = jest.requireActual('./partner-data-purge.job');
    fake.oldActivity = Number.MAX_SAFE_INTEGER;

    await execute(log);

    expect(fake.events.filter((e) => e.startsWith('activity'))).toHaveLength(MAX_BATCHES_PER_TARGET);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('다음 실행에서 이어'));
  });
});

describe('partner-data-purge — 알림 읽음 행 선삭제', () => {
  it('같은 배치의 알림 ID 로 읽음 행을 먼저 지우고 알림을 지운다(한 트랜잭션)', async () => {
    fake.oldNotifications = ['n1', 'n2', 'n3'];
    fake.reads.set('n1', 2).set('n3', 1).set('keep', 4);

    await execute(log);

    const noti = fake.events.filter((e) => /^(select|read|notification)/.test(e));
    expect(noti).toEqual(['select:3', 'read:3', 'notification:3']);
    const readCall = fake.calls.find((c) => c.sql === SQL.notificationRead)!;
    const notiCall = fake.calls.find((c) => c.sql === SQL.notification)!;
    expect(readCall.params).toEqual([['n1', 'n2', 'n3']]);
    expect(notiCall.params).toEqual([['n1', 'n2', 'n3']]);
    expect(fake.calls.indexOf(readCall)).toBeLessThan(fake.calls.indexOf(notiCall));
    // 보존 기간 안의 알림 읽음 행은 남는다
    expect([...fake.reads.entries()]).toEqual([['keep', 4]]);
    expect(fake.committed).toBe(1);
    expect(infoText()).toContain('알림(180일) 3건(읽음 3건)');
  });

  it('알림 DELETE 가 실패하면 그 배치를 롤백하고 예외를 던진다(p-retry 재시도)', async () => {
    fake.oldNotifications = ['n1'];
    fake.failOn = 'DELETE FROM partner_notification WHERE';

    await expect(execute(log)).rejects.toThrow('주입 실패');

    expect(fake.rolledBack).toBe(1);
    expect(fake.committed).toBe(0);
    expect(fake.released).toBe(1);
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('파기 완료'));
  });
});

describe('partner-data-purge — 테이블 없음(W10 DDL 적용 전)', () => {
  it('테이블이 모두 없으면 오류 로그만 남기고 삭제 없이 정상 종료한다(예외 없음)', async () => {
    fake.present.clear();

    await expect(execute(log)).resolves.toBeUndefined();

    expect(fake.calls.map((c) => c.sql)).toHaveLength(1); // to_regclass 확인 1번뿐
    expect(fake.calls[0].sql).toContain('to_regclass');
    expect(fake.calls[0].params).toEqual([ALL_TABLES]);
    expect(log.error).toHaveBeenCalledTimes(3);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('[PARTNER_PURGE_TABLE_MISSING]'));
    expect(fake.released).toBe(1);
  });

  it('읽음 테이블만 없어도 알림은 지우지 않고(읽음 고아 방지) 다른 대상은 계속 지운다', async () => {
    fake.present.delete('partner_notification_read');
    fake.oldNotifications = ['n1'];
    fake.oldActivity = 2;
    fake.oldReset = 1;

    await execute(log);

    expect(fake.oldNotifications).toEqual(['n1']);
    expect(fake.calls.some((c) => c.sql.includes('partner_notification'))).toBe(false);
    expect(fake.oldActivity).toBe(0);
    expect(fake.oldReset).toBe(0);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('partner_notification_read'));
    expect(infoText()).toContain('알림(180일) 건너뜀');
  });
});

describe('partner-data-purge — 로그·잡 이름', () => {
  it('로그에 ID 를 남기지 않는다(건수만)', async () => {
    fake.oldNotifications = ['noti-secret-id'];
    await execute(log);
    const all = [...log.info.mock.calls, ...log.warn.mock.calls, ...log.error.mock.calls].map((c) => String(c[0])).join('\n');
    expect(all).not.toContain('noti-secret-id');
  });

  it('advisory lock 키로 쓰이므로 고정되어야 한다', () => {
    expect(JOB_NAME).toBe('partner-data-purge');
  });
});
