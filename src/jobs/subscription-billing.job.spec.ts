/**
 * 구독 정기결제 잡 — **실제 돈을 청구하는 경로**의 회귀 테스트.
 *
 * DB·PG 는 전부 목킹한다. 검증 대상은 "어떤 상황에서 청구하는가 / 어느 PG 로 보내는가 /
 * 실패를 어떻게 기록하는가" 같은 **분기 판단**이며, SQL 자체는 여기서 다루지 않는다.
 *
 * 이 잡은 2026-09-09 기준 스케줄러에 등록되지 않은 상태(주석 처리)이고,
 * 활성화 직전이라 켜기 전에 분기 로직을 고정해 둔다.
 */
import { PaymentStatus, PlanStatus, IsYn, ActiveStatus } from '../entities/enums';

// ── 목: 데이터소스 ─────────────────────────────────────────────
const repos: Record<string, any> = {};
const transaction = jest.fn(async (cb: any) => cb(managerMock));
const managerMock = {
  create: jest.fn((_e: unknown, v: unknown) => v),
  save: jest.fn(async (v: unknown) => v),
  update: jest.fn(async () => ({})),
  insert: jest.fn(async () => ({})),
};
jest.mock('../db/data-source', () => ({
  AppDataSource: {
    getRepository: (entity: { name: string }) => repos[entity.name],
    transaction: (cb: any) => transaction(cb),
  },
}));

// ── 목: PG 클라이언트 ──────────────────────────────────────────
const chargeInicis = jest.fn();
const chargeToss = jest.fn();
jest.mock('../utils/inicis-billing.client', () => ({ chargeInicisBilling: (...a: unknown[]) => chargeInicis(...a) }));
jest.mock('../utils/toss-billing.client', () => ({ chargeBilling: (...a: unknown[]) => chargeToss(...a) }));

// 빌링키 복호화는 별도 스펙에서 검증하므로 여기선 통과시킨다
jest.mock('../utils/billing-crypto.util', () => ({ decryptBillingKey: (v: string) => v }));

import { executePrimary } from './subscription-billing.job';

const log: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

const plan = (over: Record<string, unknown> = {}) => ({
  member_plan_id: 'mp1',
  member_id: 'm1',
  plan_id: 'pl1',
  pending_plan_id: null,
  member_billing_id: 'mb1',
  next_charge_dt: '2026-09-01',
  locked_amount: 10000,
  locked_credit: 10,
  is_del: IsYn.N,
  is_active: ActiveStatus.Y,
  status: PlanStatus.ACTIVE,
  ...over,
});

const billing = (over: Record<string, unknown> = {}) => ({
  member_billing_id: 'mb1',
  billing_key: 'BILLKEY',
  customer_key: 'CUST',
  provider: 'INICIS',
  is_active: ActiveStatus.Y,
  is_del: IsYn.N,
  ...over,
});

/**
 * repos 를 세팅한다. payment 는 멱등 검사에 쓰이는 기존 결제 행.
 * ⚠️ `??` 를 쓰면 **명시적 null 이 기본값으로 되돌아간다**(빌링키 없음 케이스를 못 만든다).
 * 키 존재 여부로 판단한다.
 */
function setup(opts: { plans?: unknown[]; billing?: unknown; plan?: unknown; payment?: unknown } = {}) {
  const pick = <T,>(key: string, fallback: T): T => (key in opts ? (opts as any)[key] : fallback);

  repos.MemberPlan = { find: jest.fn().mockResolvedValue(pick('plans', [plan()])), findOne: jest.fn() };
  repos.MemberBilling = { findOne: jest.fn().mockResolvedValue(pick('billing', billing())) };
  repos.Plan = {
    findOne: jest
      .fn()
      .mockResolvedValue(pick('plan', { plan_id: 'pl1', actual_amount: 10000, credit: 10, plan_title: '베이직' })),
  };
  repos.Payment = { findOne: jest.fn().mockResolvedValue(pick('payment', null)) };
}

beforeEach(() => {
  jest.clearAllMocks();
  chargeInicis.mockResolvedValue({ tid: 'TID-INI', method: '카드' });
  chargeToss.mockResolvedValue({ paymentKey: 'PK-TOSS', method: 'CARD', lastTransactionKey: 'TX' });
});

describe('subscription-billing — PG 분기', () => {
  it("provider='INICIS' 면 이니시스로 청구한다", async () => {
    setup();
    await executePrimary(log);
    expect(chargeInicis).toHaveBeenCalledTimes(1);
    expect(chargeToss).not.toHaveBeenCalled();
  });

  it("provider 가 NULL 이면 레거시 토스로 청구한다", async () => {
    setup({ billing: billing({ provider: null }) });
    await executePrimary(log);
    expect(chargeToss).toHaveBeenCalledTimes(1);
    expect(chargeInicis).not.toHaveBeenCalled();
  });

  it("provider 대소문자가 섞여도 이니시스로 인식한다", async () => {
    setup({ billing: billing({ provider: 'inicis' }) });
    await executePrimary(log);
    expect(chargeInicis).toHaveBeenCalledTimes(1);
  });
});

describe('subscription-billing — 멱등성', () => {
  it('이번 주기 결제가 이미 DONE 이면 재청구하지 않는다', async () => {
    setup({ payment: { status: PaymentStatus.DONE } });
    await executePrimary(log);
    expect(chargeInicis).not.toHaveBeenCalled();
    expect(chargeToss).not.toHaveBeenCalled();
  });

  it('이전 시도가 ABORTED 면 다시 청구한다', async () => {
    setup({ payment: { status: PaymentStatus.ABORTED } });
    await executePrimary(log);
    expect(chargeInicis).toHaveBeenCalledTimes(1);
  });
});

describe('subscription-billing — 청구 전 방어', () => {
  it('빌링키가 없으면 청구하지 않는다', async () => {
    setup({ billing: null });
    await executePrimary(log);
    expect(chargeInicis).not.toHaveBeenCalled();
    expect(chargeToss).not.toHaveBeenCalled();
  });

  it('빌링키가 비활성이면 청구하지 않는다', async () => {
    setup({ billing: billing({ is_active: ActiveStatus.N }) });
    await executePrimary(log);
    expect(chargeInicis).not.toHaveBeenCalled();
  });

  it('금액이 0 이하면 청구하지 않는다', async () => {
    setup({ plans: [plan({ locked_amount: 0 })], plan: { plan_id: 'pl1', actual_amount: 0, credit: 0 } });
    await executePrimary(log);
    expect(chargeInicis).not.toHaveBeenCalled();
  });

  it('next_charge_dt 가 없으면 스킵한다(1970 기준 계산 방지)', async () => {
    setup({ plans: [plan({ next_charge_dt: null })] });
    await executePrimary(log);
    expect(chargeInicis).not.toHaveBeenCalled();
  });
});

describe('subscription-billing — 실패 기록의 PG', () => {
  /**
   * 회귀 방지: 예전에는 실패 기록의 pg_provider 가 'toss' 로 하드코딩돼 있어
   * 이니시스로 청구하다 실패해도 토스 실패로 남았다(PG별 통계·CS 대사 오염).
   */
  it('이니시스 청구 실패는 pg_provider=inicis 로 기록한다', async () => {
    setup();
    chargeInicis.mockRejectedValue(Object.assign(new Error('한도초과'), { code: 'LIMIT' }));

    await executePrimary(log);

    const saved = managerMock.create.mock.calls.map((c) => c[1] as Record<string, unknown>);
    const failRow = saved.find((r) => r.status === PaymentStatus.ABORTED);
    expect(failRow).toBeDefined();
    expect(failRow!.pg_provider).toBe('inicis');
    expect(failRow!.fail_code).toBe('LIMIT');
  });

  it('토스 청구 실패는 pg_provider=toss 로 기록한다', async () => {
    setup({ billing: billing({ provider: 'TOSS' }) });
    chargeToss.mockRejectedValue(Object.assign(new Error('카드오류'), { code: 'CARD' }));

    await executePrimary(log);

    const failRow = managerMock.create.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((r) => r.status === PaymentStatus.ABORTED);
    expect(failRow!.pg_provider).toBe('toss');
  });

  it('빌링키 없음(청구 시도 전)도 빌링키 태그 기준으로 기록한다', async () => {
    setup({ billing: null });

    await executePrimary(log);

    const failRow = managerMock.create.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((r) => r.status === PaymentStatus.ABORTED);
    expect(failRow!.fail_code).toBe('NO_BILLING_OR_PLAN');
  });
});

describe('subscription-billing — 한 건 실패가 다른 건을 막지 않는다', () => {
  it('여러 구독 중 하나가 터져도 나머지를 계속 처리한다', async () => {
    setup({ plans: [plan({ member_plan_id: 'a' }), plan({ member_plan_id: 'b' })] });
    chargeInicis.mockRejectedValueOnce(new Error('일시 오류')).mockResolvedValueOnce({ tid: 'T2', method: '카드' });

    await executePrimary(log);

    expect(chargeInicis).toHaveBeenCalledTimes(2);
  });
});
