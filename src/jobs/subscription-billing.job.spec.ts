/**
 * 구독 청구 잡 레벨 — 운영 게이트, provider 분기, 요약 로그.
 * 다날 청구 자체(T1~T13)는 subscription-billing.danal.spec.ts 가 검증한다. 여기서는 다날 청구를 가짜로 대체한다.
 */
import 'reflect-metadata';

const mockConfig = {
  env: 'local',
  danal: { secretKey: 'fake-secret', merchantId: 'fake-merchant', apiBaseUrl: 'https://danal.test', batchEnabled: true },
  billing: { encKey: '' },
  toss: { secretKey: '', baseUrl: 'https://toss.test' },
};
jest.mock('../config', () => ({ config: mockConfig }));

const mockGetRepository = jest.fn();
const mockTransaction = jest.fn();
const mockQuery = jest.fn();
jest.mock('../db/data-source', () => ({
  AppDataSource: { getRepository: mockGetRepository, transaction: mockTransaction, query: mockQuery },
}));

const mockChargeDanalPlan = jest.fn();
jest.mock('./subscription-billing.danal', () => ({
  ...jest.requireActual('./subscription-billing.danal'),
  chargeDanalPlan: (...a: unknown[]) => mockChargeDanalPlan(...a),
}));

const mockChargeBilling = jest.fn();
jest.mock('../utils/toss-billing.client', () => ({ chargeBilling: (...a: unknown[]) => mockChargeBilling(...a) }));

import { MemberPlan } from '../entities/member-plan.entity';
import { MemberBilling } from '../entities/member-billing.entity';
import { Plan } from '../entities/plan.entity';
import { Payment } from '../entities/payment.entity';
import { executePrimary, executeRetry } from './subscription-billing.job';

const log: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

const planRow = (id: string, billingId: string): any => ({
  member_plan_id: id,
  member_id: 'm1',
  plan_id: 'p1',
  member_billing_id: billingId,
  next_charge_dt: '2026-11-03',
  status: 'ACTIVE',
  is_active: 'Y',
});
const billing = (id: string, provider: string | null): any => ({
  member_billing_id: id,
  provider,
  billing_key: 'fake-billing-key',
  customer_key: 'fake-customer',
  is_active: 'Y',
});

let plans: any[];
let billings: Record<string, any>;
const memberPlanRepo = { find: jest.fn() };
const billingRepo = { findOne: jest.fn() };
const planRepo = { findOne: jest.fn() };
const paymentRepo = { findOne: jest.fn() };
const manager = { create: jest.fn((_e: unknown, v: any) => v), save: jest.fn(), update: jest.fn() };

const summary = () => log.info.mock.calls.map((c: unknown[]) => String(c[0])).find((m: string) => m.startsWith('처리 결과'));

beforeEach(() => {
  jest.clearAllMocks();
  mockConfig.danal.batchEnabled = true;
  plans = [];
  billings = {};
  memberPlanRepo.find.mockImplementation(async () => plans);
  billingRepo.findOne.mockImplementation(async ({ where }: any) => billings[where.member_billing_id] ?? null);
  planRepo.findOne.mockResolvedValue({ plan_id: 'p1', plan_title: '월 구독', actual_amount: 9900, credit: 10 });
  paymentRepo.findOne.mockResolvedValue(null);
  manager.save.mockImplementation(async (v: any) => ({ ...v, payment_id: 'pay-1' }));
  mockGetRepository.mockImplementation((entity: unknown) => {
    if (entity === MemberPlan) return memberPlanRepo;
    if (entity === MemberBilling) return billingRepo;
    if (entity === Plan) return planRepo;
    if (entity === Payment) return paymentRepo;
    throw new Error('unexpected repository');
  });
  mockTransaction.mockImplementation(async (cb: (m: unknown) => unknown) => cb(manager));
  mockChargeDanalPlan.mockResolvedValue('charged');
  mockChargeBilling.mockResolvedValue({ paymentKey: 'toss-pk', method: '카드', lastTransactionKey: 'toss-tx' });
});

describe('운영 게이트 (DANAL_BILLING_BATCH_ENABLED)', () => {
  it.each([
    ['executePrimary', executePrimary],
    ['executeRetry', executeRetry],
  ])('%s: 꺼져 있으면 DB 조회도 청구도 하지 않고 종료한다', async (_name, exec) => {
    mockConfig.danal.batchEnabled = false;
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', 'DANAL');

    await exec(log);

    expect(mockGetRepository).not.toHaveBeenCalled(); // 조회 함수 호출 0회
    expect(memberPlanRepo.find).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
    expect(mockChargeDanalPlan).not.toHaveBeenCalled();
    expect(mockChargeBilling).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('DANAL_BILLING_BATCH_ENABLED'));
  });

  it.each([
    ['executePrimary', executePrimary],
    ['executeRetry', executeRetry],
  ])('%s: 켜져 있을 때만 진행한다', async (_name, exec) => {
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', 'DANAL');

    await exec(log);

    expect(memberPlanRepo.find).toHaveBeenCalledTimes(1);
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(1);
  });
});

describe('provider 분기', () => {
  it.each(['DANAL', 'danal', 'Danal'])('%s → 다날 경로 (대소문자 무시), 토스로 새지 않는다', async (provider) => {
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', provider);

    await executePrimary(log);

    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(1);
    expect(mockChargeBilling).not.toHaveBeenCalled(); // 회귀: DANAL 이 토스 경로로 흘러가지 않는다
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('1차 잡은 PAST_DUE, 재시도 잡은 SUSPENDED 를 다날 경로에 넘긴다', async () => {
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', 'DANAL');

    await executePrimary(log);
    await executeRetry(log);

    expect(mockChargeDanalPlan.mock.calls[0][0]).toBe(plans[0]);
    expect(mockChargeDanalPlan.mock.calls[0][1]).toBe(billings.b1);
    expect(mockChargeDanalPlan.mock.calls[0][2]).toBe('PAST_DUE');
    expect(mockChargeDanalPlan.mock.calls[1][2]).toBe('SUSPENDED');
  });

  it.each(['INICIS', 'inicis'])('%s → 건너뜀: 청구·상태·결제 행 변경이 없고 요약에 재등록 필요 N건', async (provider) => {
    plans = [planRow('mp1', 'b1'), planRow('mp2', 'b2')];
    billings.b1 = billing('b1', provider);
    billings.b2 = billing('b2', 'INICIS');

    await executePrimary(log);

    expect(mockChargeDanalPlan).not.toHaveBeenCalled();
    expect(mockChargeBilling).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled(); // payment 삽입·구독 갱신 없음
    expect(manager.save).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
    expect(summary()).toContain('재등록 필요 2건');
  });

  it.each([
    ['NULL', null],
    ['TOSS', 'TOSS'],
  ])('%s → 기존 토스 경로', async (_name, provider) => {
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', provider);

    await executePrimary(log);

    expect(mockChargeBilling).toHaveBeenCalledTimes(1);
    expect(mockChargeBilling.mock.calls[0][0]).toMatchObject({ billingKey: 'fake-billing-key', amount: 9900 });
    expect(mockChargeDanalPlan).not.toHaveBeenCalled();
  });

  it('빌링 행이 없으면 provider 를 알 수 없어 기존 경로(결제 불가 처리)를 탄다', async () => {
    plans = [planRow('mp1', 'missing')];

    await executePrimary(log);

    expect(mockChargeDanalPlan).not.toHaveBeenCalled();
    expect(mockChargeBilling).not.toHaveBeenCalled();
    expect(mockTransaction).toHaveBeenCalledTimes(1); // markFailed
  });

  it('이니시스 호출 경로는 더 이상 없다', async () => {
    // inipay 클라이언트를 import 하지 않으므로 어떤 provider 조합에서도 호출될 수 없다
    const src = require('fs').readFileSync(require.resolve('./subscription-billing.job'), 'utf8') as string;
    expect(src).not.toContain('inipay-billing.client');
    expect(src).not.toContain('chargeInipayBilling');
  });
});

describe('요약 로그', () => {
  it('성공·건너뜀·실패·결과 불명·재등록 필요를 따로 센다. 결과 불명은 [CRITICAL] 로 남긴다', async () => {
    plans = [planRow('a', 'b1'), planRow('b', 'b1'), planRow('c', 'b1'), planRow('d', 'b1'), planRow('e', 'bi')];
    billings.b1 = billing('b1', 'DANAL');
    billings.bi = billing('bi', 'INICIS');
    mockChargeDanalPlan
      .mockResolvedValueOnce('charged')
      .mockResolvedValueOnce('skipped')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('unknown');

    await executePrimary(log);

    expect(summary()).toBe('처리 결과: 성공 1, 건너뜀 1, 실패 1, 결과 불명 1, 오류 0, 재등록 필요 1건');
    expect(JSON.stringify(log.error.mock.calls)).toContain('[CRITICAL]');
  });

  it('결과 불명·건너뜀은 구독 상태를 바꾸지 않는다(잡 레벨에서 DB 쓰기 없음)', async () => {
    plans = [planRow('a', 'b1'), planRow('b', 'b1')];
    billings.b1 = billing('b1', 'DANAL');
    mockChargeDanalPlan.mockResolvedValueOnce('unknown').mockResolvedValueOnce('skipped');

    await executePrimary(log);

    expect(mockTransaction).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('한 건이 예외를 던져도 다음 건을 계속 처리한다', async () => {
    plans = [planRow('a', 'b1'), planRow('b', 'b1')];
    billings.b1 = billing('b1', 'DANAL');
    mockChargeDanalPlan.mockRejectedValueOnce(new Error('선점 실패')).mockResolvedValueOnce('charged');

    await executePrimary(log);

    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(2);
    expect(summary()).toContain('성공 1');
    expect(summary()).toContain('오류 1');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('plan=a'), expect.anything());
  });
});

// 07-subscription-review M-9 — 어드민이 비활성화(is_active=N)한 PAST_DUE 구독은 재시도 잡이 청구·복구하지 않는다
describe('[M-9] 재시도 잡 조회 조건', () => {
  it('PAST_DUE 중 is_active=Y, is_del=N, next_charge_dt 가 있는 구독만 조회한다', async () => {
    await executeRetry(log);

    expect(memberPlanRepo.find).toHaveBeenCalledTimes(1);
    const { where } = memberPlanRepo.find.mock.calls[0][0];
    expect(where).toMatchObject({ is_del: 'N', is_active: 'Y', status: 'PAST_DUE' });
    expect(where.next_charge_dt).toBeDefined(); // Not(IsNull())
  });
});

// 07-subscription-review M-7 — 운영 배치가 다날 테스트 키(SK_TEST_)로 청구하지 않는다 (백엔드 assertNoDanalTestKeys 와 같은 규칙)
describe('[M-7] 운영 환경 다날 테스트 키 방어', () => {
  afterEach(() => {
    (mockConfig as any).env = 'local';
    mockConfig.danal.secretKey = 'fake-secret';
  });

  it.each([
    ['executePrimary', executePrimary],
    ['executeRetry', executeRetry],
  ])('%s: 운영(prod)에서 SK_TEST_ 키면 조회·청구 없이 오류로 중단한다', async (_name, exec) => {
    (mockConfig as any).env = 'prod';
    mockConfig.danal.secretKey = 'SK_TEST_abcdef';
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', 'DANAL');

    await expect(exec(log)).rejects.toThrow(/SECURITY.*DANAL_SECRET_KEY/);

    expect(memberPlanRepo.find).not.toHaveBeenCalled();
    expect(mockChargeDanalPlan).not.toHaveBeenCalled();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('SK_TEST_abcdef'); // 키 값은 로그에 남기지 않는다
  });

  it('production 표기도 막는다', async () => {
    (mockConfig as any).env = 'production';
    mockConfig.danal.secretKey = 'SK_TEST_abcdef';
    await expect(executePrimary(log)).rejects.toThrow(/SECURITY/);
  });

  it('운영이라도 라이브 키면 진행한다', async () => {
    (mockConfig as any).env = 'prod';
    mockConfig.danal.secretKey = 'SK_LIVE_abcdef';
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', 'DANAL');
    await executePrimary(log);
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(1);
  });

  it('로컬 환경의 테스트 키는 허용한다 (테스트 DB 연동용)', async () => {
    (mockConfig as any).env = 'local';
    mockConfig.danal.secretKey = 'SK_TEST_abcdef';
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', 'DANAL');
    await executePrimary(log);
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(1);
  });

  it('게이트가 꺼져 있으면 키를 검사하지 않고 조용히 종료한다', async () => {
    (mockConfig as any).env = 'prod';
    mockConfig.danal.secretKey = 'SK_TEST_abcdef';
    mockConfig.danal.batchEnabled = false;
    await expect(executePrimary(log)).resolves.toBeUndefined();
  });
});
