/**
 * 구독 청구 잡 레벨 — 운영 게이트, provider 분기, 요약 로그.
 * 다날 청구 자체(T1~T13)는 subscription-billing.danal.spec.ts 가 검증한다. 여기서는 다날 청구를 가짜로 대체한다.
 */
import 'reflect-metadata';

const mockConfig = {
  env: 'local',
  nodeEnv: 'local',
  danal: {
    secretKey: 'fake-secret',
    merchantId: 'fake-merchant',
    apiBaseUrl: 'https://danal.test',
    batchEnabled: true,
    billingAbortRatio: 0.5,
    billingAbortMinSample: 5,
  },
  billing: { encKey: '' },
  toss: { secretKey: 'fake-toss', baseUrl: 'https://toss.test' },
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

import { MemberPlan } from '../entities/member-plan.entity';
import { MemberBilling } from '../entities/member-billing.entity';
import { Plan } from '../entities/plan.entity';
import { Payment } from '../entities/payment.entity';
import { executePrimary, executeRetry } from './subscription-billing.job';
import { today, ymd } from '../utils/date.util';

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
  mockConfig.danal.billingAbortRatio = 0.5;
  mockConfig.danal.billingAbortMinSample = 5;
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
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('1차 잡은 PAST_DUE, 재시도 잡은 CANCELED(재시도 실패 시 해지)를 다날 경로에 넘긴다', async () => {
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', 'DANAL');

    await executePrimary(log);
    await executeRetry(log);

    expect(mockChargeDanalPlan.mock.calls[0][0]).toBe(plans[0]);
    expect(mockChargeDanalPlan.mock.calls[0][1]).toBe(billings.b1);
    expect(mockChargeDanalPlan.mock.calls[0][2]).toBe('PAST_DUE');
    expect(mockChargeDanalPlan.mock.calls[1][2]).toBe('CANCELED');
  });

  // PG 전환 원칙(정책 3) — 이전 PG(이니시스·토스·provider NULL) 카드는 결제일에 청구하지 않고 구독을 해지한다.
  // 잡은 판단하지 않고 chargeDanalPlan 에 넘긴다(구독 잠금·재확인 뒤에 해지해야 하므로). 토스로 새지 않는다 [H-2].
  it.each([
    ['INICIS', 'INICIS'],
    ['inicis(소문자)', 'inicis'],
    ['NULL', null],
    ['TOSS', 'TOSS'],
    ['toss(소문자)', 'toss'],
    ['빈 문자열', ''],
    ['알 수 없는 값', 'KCP'],
  ])('%s → chargeDanalPlan 에 카드 그대로 넘긴다(해지는 거기서, 잠금 아래에서)', async (_name, provider) => {
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', provider);

    await executePrimary(log);

    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(1);
    expect(mockChargeDanalPlan.mock.calls[0][1]).toBe(billings.b1);
    expect(mockTransaction).not.toHaveBeenCalled(); // 잡 레벨에서는 쓰기 없음
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('토스 시크릿 키가 있어도 NULL·TOSS 카드는 토스를 호출하지 않는다(코드 경로 자체가 없다)', () => {
    const src = require('fs').readFileSync(require.resolve('./subscription-billing.job'), 'utf8') as string;
    expect(src).not.toContain('toss-billing.client');
    expect(src).not.toContain('chargeBilling');
    expect(src).not.toContain('markFailed');
  });

  it.each([
    ['member_billing_id 가 없음', null],
    ['카드 행이 삭제됨/없음', 'missing'],
  ])('카드 정보 없음(%s) → 카드 null 로 chargeDanalPlan 에 넘긴다 (거기서 해지)', async (_name, billingId) => {
    plans = [{ ...planRow('mp1', 'x'), member_billing_id: billingId }];

    await executePrimary(log);

    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(1);
    expect(mockChargeDanalPlan.mock.calls[0][1]).toBeNull();
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('이니시스 호출 경로는 더 이상 없다', async () => {
    // inipay 클라이언트를 import 하지 않으므로 어떤 provider 조합에서도 호출될 수 없다
    const src = require('fs').readFileSync(require.resolve('./subscription-billing.job'), 'utf8') as string;
    expect(src).not.toContain('inipay-billing.client');
    expect(src).not.toContain('chargeInipayBilling');
  });
});

describe('요약 로그', () => {
  it('성공·건너뜀·실패·결과 불명·해지를 따로 센다. 결과 불명은 [CRITICAL] 로 남긴다', async () => {
    plans = [planRow('a', 'b1'), planRow('b', 'b1'), planRow('c', 'b1'), planRow('d', 'b1'), planRow('e', 'bi')];
    billings.b1 = billing('b1', 'DANAL');
    billings.bi = billing('bi', 'INICIS');
    mockChargeDanalPlan
      .mockResolvedValueOnce('charged')
      .mockResolvedValueOnce('skipped')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce('canceled');

    await executePrimary(log);

    expect(summary()).toBe('처리 결과: 성공 1, 건너뜀 1, 실패 1, 결과 불명 1, 해지 1, 오류 0건');
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
  it('PAST_DUE 중 is_active=Y, is_del=N, 결제일이 도래한(<= 오늘) 구독만 조회한다', async () => {
    await executeRetry(log);

    expect(memberPlanRepo.find).toHaveBeenCalledTimes(1);
    const { where } = memberPlanRepo.find.mock.calls[0][0];
    expect(where).toMatchObject({ is_del: 'N', is_active: 'Y', status: 'PAST_DUE' });
    // [M-2] 결제일이 아직 오지 않은 PAST_DUE 를 미리 청구하지 않는다. NULL 은 <= 비교에서 자동 제외된다.
    expect(where.next_charge_dt.type).toBe('lessThanOrEqual');
    expect(ymd(where.next_charge_dt.value)).toBe(ymd(today()));
  });
});

// 07-subscription-review M-7 + 09 N-9 — 운영 배치가 다날 테스트 키(SK_TEST_)로 청구하지 않는다.
// 운영 판단 기준: NODE_ENV 가 명시적 비운영 값(local·development·dev·test)이 아니면 운영으로 본다 (미주입·빈 값·오타·staging 포함 — fail-closed).
describe('[M-7/N-9] 운영 환경 다날 테스트 키 방어 — NODE_ENV 미주입에도 동작', () => {
  afterEach(() => {
    (mockConfig as any).nodeEnv = 'local';
    mockConfig.danal.secretKey = 'fake-secret';
  });

  it.each([
    ['executePrimary', executePrimary],
    ['executeRetry', executeRetry],
  ])('%s: 운영(prod)에서 SK_TEST_ 키면 조회·청구 없이 오류로 중단한다', async (_name, exec) => {
    (mockConfig as any).nodeEnv = 'prod';
    mockConfig.danal.secretKey = 'SK_TEST_abcdef';
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', 'DANAL');

    await expect(exec(log)).rejects.toThrow(/SECURITY.*DANAL_SECRET_KEY/);

    expect(memberPlanRepo.find).not.toHaveBeenCalled();
    expect(mockChargeDanalPlan).not.toHaveBeenCalled();
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('SK_TEST_abcdef'); // 키 값은 로그에 남기지 않는다
  });

  it.each([
    ['production', 'production'],
    ['PRODUCTION(대소문자)', 'PRODUCTION'],
    ['NODE_ENV 미주입(undefined)', undefined],
    ['빈 문자열', ''],
    ['staging(명시적 비운영 목록에 없음)', 'staging'],
    ['오타(prodd)', 'prodd'],
  ])('NODE_ENV=%s 이고 SK_TEST_ 키면 중단한다 (fail-closed)', async (_name, nodeEnv) => {
    (mockConfig as any).nodeEnv = nodeEnv;
    mockConfig.danal.secretKey = 'SK_TEST_abcdef';
    await expect(executePrimary(log)).rejects.toThrow(/SECURITY/);
    expect(memberPlanRepo.find).not.toHaveBeenCalled();
  });

  it.each(['local', 'development', 'dev', 'test', 'LOCAL'])('명시적 비운영 NODE_ENV=%s 의 테스트 키는 허용한다 (테스트 DB 연동용)', async (nodeEnv) => {
    (mockConfig as any).nodeEnv = nodeEnv;
    mockConfig.danal.secretKey = 'SK_TEST_abcdef';
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', 'DANAL');
    await executePrimary(log);
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, 'prod'])('NODE_ENV=%s 라도 라이브 키면 진행한다', async (nodeEnv) => {
    (mockConfig as any).nodeEnv = nodeEnv;
    mockConfig.danal.secretKey = 'SK_LIVE_abcdef';
    plans = [planRow('mp1', 'b1')];
    billings.b1 = billing('b1', 'DANAL');
    await executePrimary(log);
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(1);
  });

  it('게이트가 꺼져 있으면 키를 검사하지 않고 조용히 종료한다', async () => {
    (mockConfig as any).nodeEnv = undefined;
    mockConfig.danal.secretKey = 'SK_TEST_abcdef';
    mockConfig.danal.batchEnabled = false;
    await expect(executePrimary(log)).resolves.toBeUndefined();
  });
});

describe('테스트 옵션 --member (재현 전용)', () => {
  const { setTestOptions, resetTestOptions } = require('../utils/test-options');
  afterEach(() => resetTestOptions());

  it('옵션이 없으면 조회 조건에 member_id 가 없다', async () => {
    await executePrimary(log);
    for (const w of memberPlanRepo.find.mock.calls[0][0].where) expect(w).not.toHaveProperty('member_id');
  });

  it('--member 가 있으면 primary·retry 조회 모두 그 회원으로 고정한다', async () => {
    setTestOptions({ memberId: 'm-only' });
    await executePrimary(log);
    await executeRetry(log);
    for (const w of memberPlanRepo.find.mock.calls[0][0].where) expect(w.member_id).toBe('m-only');
    expect(memberPlanRepo.find.mock.calls[1][0].where.member_id).toBe('m-only');
  });
});

// 10 P-1 — 한 잡에서 카드 거절·다날 비카드 오류 비율이 임계를 넘으면 잡을 중단한다(되돌릴 수 없는 대량 해지 차단).
describe('[P-1] 거절·비카드 오류 비율이 임계를 넘으면 잡을 중단한다', () => {
  // 앞 테스트가 중단돼 쓰지 않은 Once 결과가 큐에 남지 않게 한다(clearAllMocks 는 큐를 비우지 않는다)
  beforeEach(() => {
    mockChargeDanalPlan.mockReset();
    mockChargeDanalPlan.mockResolvedValue('charged');
  });
  const many = (n: number) => {
    plans = Array.from({ length: n }, (_, i) => planRow(`mp${i}`, 'b1'));
    billings.b1 = billing('b1', 'DANAL');
  };
  const results = (...r: string[]) => r.forEach(x => mockChargeDanalPlan.mockResolvedValueOnce(x));

  it('재현: 재시도 잡에서 전부 거절로 나오면(비밀키 오교체·계약 만료) 표본 5건에서 멈추고 나머지 구독은 건드리지 않는다', async () => {
    many(20);
    results(...Array(20).fill('declined'));

    await expect(executeRetry(log)).rejects.toThrow('[CRITICAL]');

    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(5);
    expect(JSON.stringify(log.error.mock.calls)).toContain('[CRITICAL]');
    expect(JSON.stringify(log.error.mock.calls)).toContain('중단');
    expect(summary()).toBeDefined(); // 중단해도 요약은 남긴다
  });

  it('1차 잡도 같다', async () => {
    many(12);
    results(...Array(12).fill('declined'));
    await expect(executePrimary(log)).rejects.toThrow('[CRITICAL]');
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(5);
  });

  it('다날 비카드 오류(system_error)도 같은 임계로 센다 — 전부 401 이면 헛돌지 않고 멈춘다', async () => {
    many(20);
    results(...Array(20).fill('system_error'));
    await expect(executePrimary(log)).rejects.toThrow('[CRITICAL]');
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(5);
  });

  it('최소 표본(5건) 전에는 중단하지 않는다 — 4건 전부 거절이어도 끝까지 처리', async () => {
    many(4);
    results('declined', 'declined', 'declined', 'declined');
    await executeRetry(log);
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(4);
    expect(summary()).toContain('실패 4');
  });

  it('정상 범위(거절 비율 임계 이하)는 끝까지 처리한다: 10건 중 5건 거절 = 0.5 는 넘지 않는다', async () => {
    many(10);
    results('charged', 'declined', 'charged', 'declined', 'charged', 'declined', 'charged', 'declined', 'charged', 'declined');
    await executePrimary(log);
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(10);
    expect(summary()).toBe('처리 결과: 성공 5, 건너뜀 0, 실패 5, 결과 불명 0, 해지 0, 오류 0건');
  });

  it('성공이 섞여 비율이 낮으면 거절이 연달아 나와도 중단하지 않는다', async () => {
    many(30);
    results(...Array(20).fill('charged'), ...Array(10).fill('declined'));
    await executePrimary(log);
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(30);
  });

  it('건너뜀·해지(이전 PG 등)는 표본에 넣지 않는다 — 다날을 호출하지 않았기 때문', async () => {
    many(12);
    results(...Array(8).fill('skipped'), 'canceled', 'canceled', 'declined', 'declined');
    await executePrimary(log);
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(12);
  });

  it('임계는 설정으로 바꾼다: 비율 0.9·표본 10', async () => {
    mockConfig.danal.billingAbortRatio = 0.9;
    mockConfig.danal.billingAbortMinSample = 10;
    many(20);
    results(...Array(20).fill('declined'));
    await expect(executePrimary(log)).rejects.toThrow('[CRITICAL]');
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(10);
  });

  it('설정이 없는 환경(구 설정)에서도 기본값(0.5, 5)으로 동작한다', async () => {
    delete (mockConfig.danal as any).billingAbortRatio;
    delete (mockConfig.danal as any).billingAbortMinSample;
    many(20);
    results(...Array(20).fill('declined'));
    await expect(executePrimary(log)).rejects.toThrow('[CRITICAL]');
    expect(mockChargeDanalPlan).toHaveBeenCalledTimes(5);
  });

  it('비카드 오류가 있으면 요약과 별도로 [CRITICAL] 로 알린다', async () => {
    many(2);
    results('system_error', 'charged');
    await executePrimary(log);
    expect(JSON.stringify(log.error.mock.calls)).toContain('[CRITICAL]');
    expect(JSON.stringify(log.error.mock.calls)).toContain('카드 거절이 아닌');
  });
});
