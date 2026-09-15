/**
 * 정산 자동 생성 — **파트너에게 실제로 지급되는 금액**을 만드는 잡의 회귀 테스트.
 *
 * 중복 생성되면 이중 지급, 금액 계산이 틀리면 과소/과다 지급이다.
 * DB 는 전부 목킹하고 "얼마를 만드는가 / 언제 만들지 않는가"만 검증한다.
 */
import { ActiveStatus, IsYn, SettlementStatus } from '../entities/enums';

const repos: Record<string, any> = {};
jest.mock('../db/data-source', () => ({
  AppDataSource: { getRepository: (e: { name: string }) => repos[e.name] },
}));

// 정책이 없을 때 쓰이는 기본 단가/수수료율을 고정한다
jest.mock('../config', () => ({
  config: { params: { settlementDefaultUnitPrice: 10000, settlementDefaultCommissionRate: 0.2 } },
}));

import { execute, JOB_NAME } from './auto-settlement.job';

const log: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const saved: Record<string, unknown>[] = [];

/** 세션 수를 반환하는 QueryBuilder 목 */
function sessionQb(count: number) {
  const qb: any = {
    innerJoin: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getCount: jest.fn().mockResolvedValue(count),
  };
  return qb;
}

function setup(opts: {
  studios?: { studio_id: string }[];
  sessionCount?: number;
  duplicate?: unknown;
  policies?: unknown[];
} = {}) {
  saved.length = 0;
  repos.Studio = { find: jest.fn().mockResolvedValue(opts.studios ?? [{ studio_id: 's1' }]) };
  repos.MemberClassSession = { createQueryBuilder: jest.fn(() => sessionQb(opts.sessionCount ?? 10)) };
  repos.SettlementPolicy = { find: jest.fn().mockResolvedValue(opts.policies ?? []) };
  repos.Settlement = {
    findOne: jest.fn().mockResolvedValue('duplicate' in opts ? opts.duplicate : null),
    create: jest.fn((v: Record<string, unknown>) => v),
    save: jest.fn(async (v: Record<string, unknown>) => {
      saved.push(v);
      return v;
    }),
  };
}

beforeEach(() => jest.clearAllMocks());

describe('auto-settlement — 금액 계산', () => {
  it('기본 정책: 세션수 × 단가, 수수료는 반올림, 지급액은 차액', async () => {
    setup({ sessionCount: 10 }); // 10 × 10,000 = 100,000 / 수수료 20% = 20,000 / 지급 80,000
    await execute(log);

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      total_sessions: 10,
      gross_amount: 100000,
      commission: 20000,
      net_amount: 80000,
      status: SettlementStatus.PENDING,
    });
  });

  it('수수료는 반올림한다 — 절삭/올림과 결과가 달라지는 값으로 검증', async () => {
    // 1 × 10,000 = 10,000 · 12.345% = 1,234.5
    //   round → 1235 · floor → 1234 · ceil → 1235
    // 나누어떨어지는 값을 쓰면 floor 로 바꿔도 테스트가 통과해 버린다(실제로 그런 케이스였다).
    setup({ sessionCount: 1, policies: [{ studio_id: null, unit_price: 10000, commission_rate: '0.12345' }] });
    await execute(log);
    expect(saved[0].commission).toBe(1235); // floor 였다면 1234
    expect(saved[0].net_amount).toBe(8765);
  });

  it('반올림 경계 아래(.4)는 내려간다 — 올림으로 바뀌면 실패', async () => {
    // 1 × 10,000 = 10,000 · 12.344% = 1,234.4 → round 1234 · ceil 1235
    setup({ sessionCount: 1, policies: [{ studio_id: null, unit_price: 10000, commission_rate: '0.12344' }] });
    await execute(log);
    expect(saved[0].commission).toBe(1234);
  });

  it('gross = commission + net 항등식이 항상 성립한다', async () => {
    setup({ sessionCount: 7, policies: [{ studio_id: null, unit_price: 9900, commission_rate: '0.033' }] });
    await execute(log);
    const s = saved[0] as Record<string, number>;
    expect(s.commission + s.net_amount).toBe(s.gross_amount);
  });

  it('수수료율이 문자열로 와도 숫자로 계산한다(numeric 컬럼)', async () => {
    setup({ sessionCount: 5, policies: [{ studio_id: null, unit_price: 10000, commission_rate: '0.10' }] });
    await execute(log);
    expect(saved[0].commission).toBe(5000);
  });
});

describe('auto-settlement — 정책 우선순위', () => {
  it('스튜디오 정책이 전역 정책보다 우선한다', async () => {
    setup({
      sessionCount: 2,
      policies: [
        { studio_id: null, unit_price: 10000, commission_rate: '0.2' },
        { studio_id: 's1', unit_price: 20000, commission_rate: '0.1' },
      ],
    });
    await execute(log);
    expect(saved[0].gross_amount).toBe(40000); // 2 × 20,000
    expect(saved[0].commission).toBe(4000); // 10%
  });

  it('해당 스튜디오 정책이 없으면 전역 정책을 쓴다', async () => {
    setup({
      sessionCount: 2,
      policies: [
        { studio_id: null, unit_price: 30000, commission_rate: '0.5' },
        { studio_id: 'other', unit_price: 99999, commission_rate: '0.9' },
      ],
    });
    await execute(log);
    expect(saved[0].gross_amount).toBe(60000);
  });

  it('정책이 하나도 없으면 env 기본값을 쓴다', async () => {
    setup({ sessionCount: 1, policies: [] });
    await execute(log);
    expect(saved[0].gross_amount).toBe(10000);
    expect(saved[0].commission).toBe(2000);
  });

  it('활성·미삭제 정책만 조회한다', async () => {
    setup({ sessionCount: 1 });
    await execute(log);
    expect(repos.SettlementPolicy.find).toHaveBeenCalledWith({
      where: { is_active: ActiveStatus.Y, is_del: IsYn.N },
    });
  });
});

describe('auto-settlement — 중복 생성 방지(이중 지급 방어)', () => {
  it('같은 기간에 취소되지 않은 정산이 있으면 만들지 않는다', async () => {
    setup({ duplicate: { settlement_id: 'existing' } });
    await execute(log);
    expect(saved).toHaveLength(0);
  });

  it('중복 검사는 (스튜디오, 기간 시작일) 로 조회한다', async () => {
    setup({ duplicate: null });
    await execute(log);
    const where = repos.Settlement.findOne.mock.calls[0][0].where;
    expect(where.studio_id).toBe('s1');
    expect(where.period_start).toBeDefined();
    // 현재 구현은 상태를 조건에 넣지 않는다 — 취소된 정산이 있어도 재생성되지 않는다.
    // 백엔드의 부분 유니크 인덱스(취소 제외)와 어긋나는 지점이라,
    // 'CANCELLED 제외' 변경안이 backup/dev-parallel-impl 브랜치에 있다.
  });

  it('완료 세션이 0건이면 빈 정산을 만들지 않는다', async () => {
    setup({ sessionCount: 0 });
    await execute(log);
    expect(saved).toHaveLength(0);
  });
});

describe('auto-settlement — 다중 스튜디오', () => {
  it('스튜디오별로 각각 생성한다', async () => {
    setup({ studios: [{ studio_id: 's1' }, { studio_id: 's2' }], sessionCount: 4 });
    await execute(log);
    expect(saved).toHaveLength(2);
    expect(saved.map((s) => s.studio_id)).toEqual(['s1', 's2']);
  });
});

describe('auto-settlement — 잡 이름', () => {
  it('advisory lock 키로 쓰이므로 고정되어야 한다', () => {
    expect(JOB_NAME).toBe('auto-settlement');
  });
});
