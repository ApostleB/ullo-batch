/**
 * 다날 구독 월 자동결제(chargeDanalPlan) — 동작표 T1~T13 의 "배치" 열 검증.
 * 백엔드(subscription-charge.*.spec / subscription-settle.spec)와 같은 표를 테스트 이름의 [T#] 로 짝짓는다.
 *
 * 다날 HTTP·DB 는 전부 가짜다(실제 다날 호출 없음). 키·빌링키 값도 전부 가짜 문자열이다.
 * 금전 경로 단언은 "다날 호출 횟수"와 "호출 시점의 선점 행(CONFIRMING) 존재"를 함께 본다.
 */
import 'reflect-metadata';
import { createCipheriv, createHash, randomBytes } from 'crypto';

const mockConfig = {
  danal: { secretKey: 'fake-secret', merchantId: 'fake-merchant', apiBaseUrl: 'https://danal.test', batchEnabled: true },
  billing: { encKey: 'fake-enc-key' },
};
jest.mock('../config', () => ({ config: mockConfig }));

// ---------- 인메모리 가짜 DB ----------
type Row = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Payment } = require('../entities/payment.entity');
const { MemberPlan } = require('../entities/member-plan.entity');
const { MemberCredit } = require('../entities/member-credit.entity');
const { MemberCreditLog } = require('../entities/member-credit-log.entity');
const { Plan } = require('../entities/plan.entity');

class FakeDb {
  payments: Row[] = [];
  plans: Row[] = [];
  credits: Row[] = [];
  creditLogs: Row[] = [];
  masters: Row[] = [];
  members: Row[] = [];
  queries: { sql: string; params: any[] }[] = [];
  /** 이 엔티티의 save 가 던진다(지급 트랜잭션 실패 주입) */
  failSaveOf: any = null;
  /** 트랜잭션이 커밋된 뒤 오류를 던진다 */
  throwAfterCommit: Error | null = null;
  /** 트랜잭션 밖 Payment 조회 실패 주입 */
  failPaymentRead = false;
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;
  manager: any;
  private txManager: any;

  constructor() {
    this.manager = this.build(false);
    this.txManager = this.build(true);
  }

  private table(e: any): Row[] {
    if (e === Payment) return this.payments;
    if (e === MemberPlan) return this.plans;
    if (e === MemberCredit) return this.credits;
    if (e === MemberCreditLog) return this.creditLogs;
    if (e === Plan) return this.masters;
    throw new Error('unknown entity');
  }

  private pk(e: any): string {
    if (e === Payment) return 'payment_id';
    if (e === MemberPlan) return 'member_plan_id';
    if (e === MemberCredit) return 'member_credit_id';
    if (e === MemberCreditLog) return 'member_credit_log_id';
    return 'plan_id';
  }

  private matches(row: Row, where: Row): boolean {
    return Object.entries(where).every(([k, v]) => row[k] === v);
  }

  private snapshot() {
    return structuredClone({ p: this.payments, pl: this.plans, c: this.credits, l: this.creditLogs });
  }

  private restore(s: ReturnType<FakeDb['snapshot']>) {
    this.payments = s.p;
    this.plans = s.pl;
    this.credits = s.c;
    this.creditLogs = s.l;
  }

  private uniqueCheck(candidate: Row, selfId?: string) {
    const dupOrder = candidate.order_id && this.payments.some((p) => p.order_id === candidate.order_id && p.payment_id !== selfId);
    const dupTid =
      candidate.pg_transaction_id && this.payments.some((p) => p.pg_transaction_id === candidate.pg_transaction_id && p.payment_id !== selfId);
    if (dupOrder || dupTid) throw Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
  }

  /** 트랜잭션은 직렬로 실행한다 — 실제 DB 의 pg_advisory_xact_lock(같은 주기 키) 직렬화를 흉내 낸다 */
  transaction = (cb: (m: any) => Promise<any>) => {
    const run = this.chain.then(async () => {
      const snap = this.snapshot();
      let result: any;
      try {
        result = await cb(this.txManager);
      } catch (err) {
        this.restore(snap); // 롤백
        throw err;
      }
      if (this.throwAfterCommit) {
        const e = this.throwAfterCommit;
        this.throwAfterCommit = null;
        throw e; // 커밋 후 오류
      }
      return result;
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  private build(isTx: boolean) {
    return {
      query: async (sql: string, params: any[] = []) => {
        this.queries.push({ sql, params });
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('FROM payment WHERE order_id')) {
          const [key, pattern] = params as [string, string];
          const prefix = pattern.replace(/\\(.)/g, '$1').replace(/%$/, '');
          return this.payments
            .filter((p) => p.order_id === key || (p.order_id ?? '').startsWith(prefix))
            .map((p) => ({ payment_id: p.payment_id, order_id: p.order_id, status: p.status, fail_code: p.fail_code ?? null }));
        }
        if (sql.includes('FROM member WHERE')) {
          return this.members.filter((mm) => mm.member_id === params[0]).map((mm) => ({ is_del: mm.is_del }));
        }
        if (sql.includes('FROM member_credit')) {
          const sum = this.credits.filter((c) => c.member_id === params[0] && c.is_del === 'N').reduce((a, c) => a + c.credit, 0);
          return [{ sum: String(sum) }];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      create: (E: any, obj: Row) => {
        Object.defineProperty(obj, '__e', { value: E, enumerable: false });
        return obj;
      },
      save: async (o: Row) => {
        const E = (o as any).__e;
        if (this.failSaveOf && this.failSaveOf === E) throw new Error('지급 저장 실패(주입)');
        if (E === Payment) this.uniqueCheck(o);
        const id = `${this.pk(E)}-${++this.seq}`;
        const row = { ...o, [this.pk(E)]: id };
        this.table(E).push(row);
        return row;
      },
      findOne: async (E: any, opts: { where: Row }) => {
        if (!isTx && E === Payment && this.failPaymentRead) throw new Error('재조회 실패(주입)');
        const row = this.table(E).find((r) => this.matches(r, opts.where));
        return row ? { ...row } : null;
      },
      update: async (E: any, criteria: Row, patch: Row) => {
        const rows = this.table(E).filter((r) => this.matches(r, criteria));
        for (const r of rows) {
          if (E === Payment) this.uniqueCheck({ ...r, ...patch }, r.payment_id);
          Object.assign(r, patch);
        }
        return { affected: rows.length };
      },
    };
  }
}

const mockDb = new FakeDb();
jest.mock('../db/data-source', () => ({ AppDataSource: mockDb }));

const mockConfirm = jest.fn();
const mockCancel = jest.fn();
jest.mock('../utils/danal-billing.client', () => ({
  ...jest.requireActual('../utils/danal-billing.client'),
  confirmBilling: (...a: unknown[]) => mockConfirm(...a),
  cancel: (...a: unknown[]) => mockCancel(...a),
}));

import { chargeDanalPlan, OnFailStatus } from './subscription-billing.danal';
import { DanalApiError, DanalResultUnknownError } from '../utils/danal-billing.client';
import { ymd } from '../utils/date.util';

// ---------- 픽스처 ----------
const ENC_SECRET = 'fake-enc-key';
const PLAIN_KEY = 'fake-plain-billing-key';
const K = 'sub_mp1_202611';

function encrypt(plain: string, secret = ENC_SECRET): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', createHash('sha256').update(secret, 'utf8').digest(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}
const ENCRYPTED_KEY = encrypt(PLAIN_KEY);

const planRow = (over: Row = {}): Row => ({
  member_plan_id: 'mp1',
  member_id: 'm1',
  plan_id: 'p1',
  status: 'ACTIVE',
  is_active: 'Y',
  is_del: 'N',
  member_billing_id: 'b1',
  next_charge_dt: '2026-11-03',
  start_dt: '2026-10-03',
  end_dt: '2026-11-03',
  pending_plan_id: null,
  locked_amount: 9900,
  locked_credit: 10,
  last_payment_id: null,
  canceled_at: null,
  ...over,
});
const billingRow = (over: Row = {}): Row => ({
  member_billing_id: 'b1',
  member_id: 'm1',
  provider: 'DANAL',
  billing_key: ENCRYPTED_KEY,
  customer_key: 'bill_x',
  is_active: 'Y',
  is_del: 'N',
  ...over,
});

const log: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

let planInDb: Row;
function seed(over: Row = {}) {
  planInDb = planRow(over);
  mockDb.plans.push({ ...planInDb });
  mockDb.masters.push({ plan_id: 'p1', plan_title: '월 구독', actual_amount: 9900, credit: 10, is_del: 'N' });
}
const run = (over: { plan?: Row; billing?: Row; onFail?: OnFailStatus } = {}) =>
  chargeDanalPlan({ ...planInDb, ...over.plan } as any, billingRow(over.billing) as any, over.onFail ?? 'PAST_DUE', log);

const dbPlan = () => mockDb.plans.find((p) => p.member_plan_id === 'mp1')!;
const logged = () => JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
const okConfirm = (over: Row = {}) =>
  mockConfirm.mockImplementation(async (i: any) => ({ transactionId: 'tx-1', orderId: i.orderId, amount: i.amount, ...over }));
const row = (orderId: string, status: string, over: Row = {}): Row => ({
  payment_id: `seed-${orderId}`,
  member_id: 'm1',
  order_id: orderId,
  status,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.payments = [];
  mockDb.plans = [];
  mockDb.credits = [];
  mockDb.creditLogs = [];
  mockDb.masters = [];
  mockDb.members = [{ member_id: 'm1', is_del: 'N' }];
  mockDb.queries = [];
  mockDb.failSaveOf = null;
  mockDb.throwAfterCommit = null;
  mockDb.failPaymentRead = false;
  mockConfig.danal.secretKey = 'fake-secret';
  mockConfig.danal.merchantId = 'fake-merchant';
  mockConfig.billing.encKey = ENC_SECRET;
  seed();
});

// ====================================================================
describe('[T1] 주기에 DONE 이 있으면 청구 없이 결제일만 전진', () => {
  it.each([
    ['이니시스 시절 order_id===K', K],
    ['다날 시도 행 K_1', `${K}_1`],
  ])('%s', async (_name, orderId) => {
    mockDb.payments.push(row(orderId, 'DONE'));

    const r = await run();

    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(1); // payment 변경 없음
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-03');
    expect(ymd(dbPlan().end_dt)).toBe('2026-12-03');
    expect(dbPlan().status).toBe('ACTIVE');
  });

  it('PAST_DUE 였던 구독도 DONE 이 있으면 ACTIVE 로 돌아오며 결제일이 전진한다', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    mockDb.payments.push(row(`${K}_1`, 'DONE'));
    await run({ plan: { status: 'PAST_DUE' }, onFail: 'SUSPENDED' });
    expect(dbPlan().status).toBe('ACTIVE');
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-03');
  });
});

describe('[T2] 주기에 CONFIRMING 이 있으면 건너뜀', () => {
  it('다날 호출 없음, payment·구독 변경 없음', async () => {
    mockDb.payments.push(row(`${K}_1`, 'CONFIRMING', { fail_code: 'CONFIRM_UNKNOWN' }));
    const before = JSON.stringify([mockDb.payments, mockDb.plans]);

    const r = await run();

    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(JSON.stringify([mockDb.payments, mockDb.plans])).toBe(before);
  });
});

describe('[T3] 시도 번호가 9 를 넘으면 청구하지 않고 오류 로그', () => {
  it('K_9 까지 시도한 주기', async () => {
    mockDb.payments.push(row(`${K}_9`, 'ABORTED', { fail_code: 'CARD_LIMIT' }));

    const r = await run();

    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(1);
    expect(dbPlan().status).toBe('ACTIVE');
    expect(log.error).toHaveBeenCalled();
  });
});

describe('[T4] 승인 성공 + 대조 일치 → 지급', () => {
  it('선점 행이 있는 상태에서 다날을 1회 호출하고 DONE·크레딧·구독 갱신', async () => {
    let atCall: Row[] = [];
    mockConfirm.mockImplementation(async (i: any) => {
      atCall = mockDb.payments.map((p) => ({ ...p }));
      return { transactionId: 'tx-1', orderId: i.orderId, amount: i.amount };
    });

    const r = await run();

    expect(r).toBe('charged');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    // 호출 시점에 이미 CONFIRMING 선점 행이 있었다
    expect(atCall).toHaveLength(1);
    expect(atCall[0]).toMatchObject({ order_id: `${K}_1`, status: 'CONFIRMING', pg_provider: 'danal', member_plan_id: 'mp1' });
    expect(mockConfirm.mock.calls[0][0]).toEqual({
      billingKey: PLAIN_KEY,
      userId: 'm1',
      amount: 9900,
      orderName: '월 구독',
      orderId: `${K}_1`,
    });

    const pay = mockDb.payments[0];
    expect(pay).toMatchObject({
      status: 'DONE',
      payment_key: 'tx-1',
      pg_transaction_id: 'tx-1',
      method: 'CARD',
      purchase_type: 'SUBSCRIPTION',
      payment_type: 'CREDIT',
      member_id: 'm1',
      plan_id: 'p1',
      amount: 9900,
      grant_credit: 10,
      order_id: `${K}_1`,
    });
    expect(pay.paid_at).toBeInstanceOf(Date);

    expect(mockDb.credits).toHaveLength(1);
    expect(mockDb.credits[0]).toMatchObject({
      credit_type: 'SUBSCRIPTION',
      init_credit: 10,
      credit: 10,
      source_payment_id: pay.payment_id,
      member_membership_id: 'mp1',
    });
    // 유효 3개월
    const start = mockDb.credits[0].start_dt as Date;
    expect(ymd(mockDb.credits[0].end_dt)).toBe(ymd(new Date(start.getFullYear(), start.getMonth() + 3, start.getDate())));
    expect(mockDb.creditLogs[0]).toMatchObject({ credit_action: 10, total_credit: 10, credit_type: 'SUBSCRIPTION' });

    expect(dbPlan()).toMatchObject({
      status: 'ACTIVE',
      is_active: 'Y',
      last_payment_id: pay.payment_id,
      plan_id: 'p1',
      pending_plan_id: null,
      locked_amount: 9900,
      locked_credit: 10,
    });
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-03');
    expect(ymd(dbPlan().end_dt)).toBe('2026-12-03');
  });

  it('주기 마지막 날 앵커는 월말로 클램프된다 (1/31 → 2/28)', async () => {
    mockDb.plans[0].next_charge_dt = '2027-01-31';
    okConfirm();
    await run({ plan: { next_charge_dt: '2027-01-31' } });
    expect(ymd(dbPlan().next_charge_dt)).toBe('2027-02-28');
  });

  it('로그에 빌링키 평문·암호문이 남지 않는다', async () => {
    okConfirm();
    await run();
    expect(logged()).not.toContain(PLAIN_KEY);
    expect(logged()).not.toContain(ENCRYPTED_KEY);
  });
});

describe('[T5] 다날이 거절(DanalApiError) → ABORTED + 구독 상태 전이', () => {
  beforeEach(() => mockConfirm.mockRejectedValue(new DanalApiError('CARD_LIMIT', '한도 초과')));

  it('1차 잡: 선점 행을 ABORTED(fail_code=err.code) 로 갱신하고 PAST_DUE. 별도 _fail_ 행은 만들지 않는다', async () => {
    const r = await run({ onFail: 'PAST_DUE' });

    expect(r).toBe('failed');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockDb.payments).toHaveLength(1);
    expect(mockDb.payments[0]).toMatchObject({ order_id: `${K}_1`, status: 'ABORTED', fail_code: 'CARD_LIMIT', fail_reason: '한도 초과' });
    expect(mockDb.payments.some((p) => (p.order_id ?? '').includes('_fail_'))).toBe(false);
    expect(dbPlan().status).toBe('PAST_DUE');
    expect(dbPlan().is_active).toBe('Y');
    expect(mockDb.credits).toHaveLength(0);
  });

  it('재시도 잡: SUSPENDED + 비활성 + canceled_at', async () => {
    mockDb.plans[0].status = 'PAST_DUE';

    const r = await run({ plan: { status: 'PAST_DUE' }, onFail: 'SUSPENDED' });

    expect(r).toBe('failed');
    expect(dbPlan()).toMatchObject({ status: 'SUSPENDED', is_active: 'N' });
    expect(dbPlan().canceled_at).toBeInstanceOf(Date);
    expect(mockDb.payments[0]).toMatchObject({ status: 'ABORTED', fail_code: 'CARD_LIMIT' });
  });
});

describe('[T6] 결과 불명 → CONFIRMING 유지, 재시도 없음, 구독 상태 불변', () => {
  it('CONFIRM_UNKNOWN 으로 기록하고 PAST_DUE 로 만들지 않는다', async () => {
    mockConfirm.mockRejectedValue(new DanalResultUnknownError('다날 응답을 받지 못했습니다. (ECONNABORTED)'));

    const r = await run();

    expect(r).toBe('unknown');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockDb.payments[0]).toMatchObject({ order_id: `${K}_1`, status: 'CONFIRMING', fail_code: 'CONFIRM_UNKNOWN' });
    expect(dbPlan().status).toBe('ACTIVE');
    expect(mockDb.credits).toHaveLength(0);
    expect(log.error).toHaveBeenCalled();
  });

  it('다음 실행은 같은 주기를 건너뛰어 같은 orderId 를 재호출하지 않는다', async () => {
    mockConfirm.mockRejectedValue(new DanalResultUnknownError('timeout'));
    await run();
    const r = await run();
    expect(r).toBe('skipped');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockDb.payments).toHaveLength(1);
  });

  it('다날 클라이언트가 예상 밖 오류를 던져도 결과 불명으로 본다(돈이 나갔을 수 있다)', async () => {
    mockConfirm.mockRejectedValue(new Error('알 수 없는 오류'));
    expect(await run()).toBe('unknown');
    expect(mockDb.payments[0].status).toBe('CONFIRMING');
  });
});

describe('[T7] 성공인데 transactionId 가 없음', () => {
  it('CONFIRMING + CONFIRM_NO_TRANSACTION_ID, [CRITICAL], 구독 불변', async () => {
    okConfirm({ transactionId: null });

    const r = await run();

    expect(r).toBe('unknown');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockDb.payments[0]).toMatchObject({ status: 'CONFIRMING', fail_code: 'CONFIRM_NO_TRANSACTION_ID' });
    expect(JSON.stringify(log.error.mock.calls)).toContain('[CRITICAL]');
    expect(dbPlan().status).toBe('ACTIVE');
  });
});

describe('[T8] orderId/amount 불일치 또는 필드 없음 → 취소', () => {
  it.each([
    ['orderId 다름', { orderId: 'other-order' }],
    ['amount 다름', { amount: 1 }],
    ['amount 필드 없음', { amount: null }],
    ['orderId 필드 없음', { orderId: null }],
  ])('%s: 취소 성공 → ABORTED + CONFIRM_MISMATCH_CANCELED, 구독 불변', async (_name, over) => {
    okConfirm(over);
    mockCancel.mockResolvedValue({ transactionId: 'cancel-1' });

    const r = await run({ onFail: 'SUSPENDED' });

    expect(r).toBe('failed');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancel.mock.calls[0][0]).toMatchObject({ transactionId: 'tx-1', amount: 9900, cancelType: 'C' });
    expect(mockDb.payments[0]).toMatchObject({ status: 'ABORTED', fail_code: 'CONFIRM_MISMATCH_CANCELED' });
    expect(dbPlan().status).toBe('ACTIVE'); // 카드 문제가 아니므로 SUSPENDED/PAST_DUE 로 만들지 않는다
    expect(mockDb.credits).toHaveLength(0);
  });

  it('취소 실패 → CONFIRMING + CONFIRM_MISMATCH_CANCEL_FAILED, [CRITICAL], 거래 ID 보존', async () => {
    okConfirm({ amount: 1 });
    mockCancel.mockRejectedValue(new DanalResultUnknownError('timeout'));

    const r = await run();

    expect(r).toBe('unknown');
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockDb.payments[0]).toMatchObject({
      status: 'CONFIRMING',
      fail_code: 'CONFIRM_MISMATCH_CANCEL_FAILED',
      pg_transaction_id: 'tx-1',
    });
    expect(JSON.stringify(log.error.mock.calls)).toContain('[CRITICAL]');
    expect(dbPlan().status).toBe('ACTIVE');
  });
});

describe('[T9] 지급 트랜잭션 실패 → 보상', () => {
  it('취소 성공 → ABORTED + GRANT_FAILED_CANCELED, 지급은 롤백, 구독 불변', async () => {
    okConfirm();
    mockCancel.mockResolvedValue({ transactionId: 'cancel-1' });
    mockDb.failSaveOf = MemberCredit;

    const r = await run();

    expect(r).toBe('failed');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockDb.payments[0]).toMatchObject({ status: 'ABORTED', fail_code: 'GRANT_FAILED_CANCELED' });
    expect(mockDb.payments[0].pg_transaction_id).toBeUndefined(); // 롤백됨
    expect(mockDb.credits).toHaveLength(0);
    expect(dbPlan().status).toBe('ACTIVE');
    expect(dbPlan().next_charge_dt).toBe('2026-11-03'); // 롤백되어 문자열 그대로
  });

  it('취소 실패 → CONFIRMING + GRANT_FAILED_CANCEL_FAILED, [CRITICAL]', async () => {
    okConfirm();
    mockCancel.mockRejectedValue(new DanalApiError('CANCEL_FAIL', '취소 불가'));
    mockDb.failSaveOf = MemberCredit;

    const r = await run();

    expect(r).toBe('unknown');
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockDb.payments[0]).toMatchObject({
      status: 'CONFIRMING',
      fail_code: 'GRANT_FAILED_CANCEL_FAILED',
      pg_transaction_id: 'tx-1',
    });
    expect(JSON.stringify(log.error.mock.calls)).toContain('[CRITICAL]');
    expect(dbPlan().status).toBe('ACTIVE');
  });

  it('재조회했더니 이미 DONE(커밋 후 오류) → 취소하지 않고 성공', async () => {
    // 선점 트랜잭션이 아니라 승인 이후의 지급 트랜잭션에서만 커밋 후 오류를 낸다
    mockConfirm.mockImplementation(async (i: any) => {
      mockDb.throwAfterCommit = new Error('commit 응답 유실');
      return { transactionId: 'tx-1', orderId: i.orderId, amount: i.amount };
    });

    const r = await run();

    expect(r).toBe('charged');
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockDb.payments[0].status).toBe('DONE');
    expect(JSON.stringify(log.error.mock.calls)).toContain('[CRITICAL]');
  });

  it('재조회 자체가 실패 → 취소하지 않고 건너뜀(결과 불명)', async () => {
    okConfirm();
    mockCancel.mockResolvedValue({ transactionId: 'x' });
    mockDb.failSaveOf = MemberCredit;
    mockDb.failPaymentRead = true;

    const r = await run();

    expect(r).toBe('unknown');
    expect(mockCancel).not.toHaveBeenCalled();
    // [M-5] 승인된 거래의 ID 와 사유를 남긴다 — 어드민이 "진행 중"과 구분하고 다날에서 거래를 찾을 수 있다
    expect(mockDb.payments[0]).toMatchObject({
      status: 'CONFIRMING',
      fail_code: 'GRANT_FAILED_UNVERIFIED',
      pg_transaction_id: 'tx-1',
    });
  });

  it('지급 전에 운영자가 취소를 진행 중(ADMIN_CANCEL_PENDING)이면 지급·취소하지 않는다', async () => {
    mockConfirm.mockImplementation(async (i: any) => {
      mockDb.payments.find((p) => p.order_id === i.orderId)!.fail_code = 'ADMIN_CANCEL_PENDING';
      return { transactionId: 'tx-1', orderId: i.orderId, amount: i.amount };
    });

    const r = await run();

    expect(r).toBe('unknown');
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockDb.credits).toHaveLength(0);
    expect(mockDb.payments[0].status).toBe('CONFIRMING');
    // 운영자가 건 표식을 덮어쓰지 않는다 — 덮으면 이후 지급 차단이 풀린다
    expect(mockDb.payments[0].fail_code).toBe('ADMIN_CANCEL_PENDING');
  });
});

describe('[T10] 응답 transactionId 가 다른 결제와 중복(23505)', () => {
  it('CONFIRMING + DUPLICATE_TRANSACTION_ID, 거래 ID 미저장, cancel 없음, [CRITICAL]', async () => {
    mockDb.payments.push(row('sub_other_202610_1', 'DONE', { pg_transaction_id: 'tx-1' }));
    okConfirm({ transactionId: 'tx-1' });

    const r = await run();

    expect(r).toBe('unknown');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockCancel).not.toHaveBeenCalled(); // 엉뚱한 거래가 취소되면 안 된다
    const mine = mockDb.payments.find((p) => p.order_id === `${K}_1`)!;
    expect(mine).toMatchObject({ status: 'CONFIRMING', fail_code: 'DUPLICATE_TRANSACTION_ID' });
    expect(mine.pg_transaction_id).toBeUndefined();
    expect(JSON.stringify(log.error.mock.calls)).toContain('[CRITICAL]');
    expect(dbPlan().status).toBe('ACTIVE');
    expect(mockDb.credits).toHaveLength(0);
  });
});

describe('[T11] 카드 provider 가 DANAL 이 아니면 청구하지 않음', () => {
  it.each([
    ['INICIS', 'INICIS'],
    ['NULL', null],
    ['TOSS', 'TOSS'],
  ])('%s', async (_name, provider) => {
    const r = await run({ billing: { provider } });

    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
    expect(dbPlan().status).toBe('ACTIVE');
  });

  it('provider 대소문자는 구분하지 않는다(danal 도 다날)', async () => {
    okConfirm();
    expect(await run({ billing: { provider: 'danal' } })).toBe('charged');
  });
});

describe('[T12] 같은 주기 동시 실행 → 한쪽만 호출', () => {
  it('두 실행이 겹쳐도 다날 호출 1회, payment 1행', async () => {
    okConfirm();

    const results = await Promise.all([run(), run()]);

    expect([...results].sort()).toEqual(['charged', 'skipped']);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockDb.payments).toHaveLength(1);
    expect(mockDb.credits).toHaveLength(1);
  });

  it('백엔드 재청구와 같은 락 문자열(subcycle:K)을 선점 트랜잭션에서 잡는다', async () => {
    okConfirm();
    await run();
    const lock = mockDb.queries.find((q) => q.sql.includes('pg_advisory_xact_lock'))!;
    expect(lock.sql).toBe(`SELECT pg_advisory_xact_lock(hashtext('subcycle:' || $1))`);
    expect(lock.params).toEqual([K]);
  });

  it('order_id UNIQUE 에 걸린 선점(경합)은 다날 호출 없이 건너뛴다', async () => {
    // 락이 못 막은 경합을 가정: 판정 조회에는 안 보이지만 삽입 시 23505
    const spy = jest.spyOn(mockDb as any, 'uniqueCheck' as any).mockImplementation(() => {
      throw Object.assign(new Error('duplicate'), { code: '23505' });
    });
    expect(await run()).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('[T13] ABORTED 시도가 이미 있으면 다음 시도 번호', () => {
  it('K_1 이 ABORTED 면 K_2 로 새 선점', async () => {
    mockDb.payments.push(row(`${K}_1`, 'ABORTED', { fail_code: 'CARD_LIMIT' }));
    okConfirm();

    const r = await run();

    expect(r).toBe('charged');
    expect(mockConfirm.mock.calls[0][0].orderId).toBe(`${K}_2`);
    expect(mockDb.payments.map((p) => p.order_id).sort()).toEqual([`${K}_1`, `${K}_2`]);
  });
});

// ====================================================================
describe('결정 4 — 취소 성공한 시스템 오류가 같은 주기에 있으면 건너뜀', () => {
  it.each(['CONFIRM_MISMATCH_CANCELED', 'GRANT_FAILED_CANCELED'])('%s 는 [CRITICAL] 로 건너뛰고 다날을 호출하지 않는다', async (code) => {
    mockDb.payments.push(row(`${K}_1`, 'ABORTED', { fail_code: code }));

    const r = await run();

    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(1);
    expect(dbPlan().status).toBe('ACTIVE');
    expect(JSON.stringify(log.error.mock.calls)).toContain('[CRITICAL]');
  });

  it('카드 거절 등 다른 ABORTED 는 막지 않는다', async () => {
    mockDb.payments.push(row(`${K}_1`, 'ABORTED', { fail_code: 'CARD_LIMIT' }));
    okConfirm();
    expect(await run()).toBe('charged');
  });

  it('다른 주기의 시스템 취소 행은 무시한다', async () => {
    mockDb.payments.push(row('sub_mp1_202610_1', 'ABORTED', { fail_code: 'GRANT_FAILED_CANCELED' }));
    okConfirm();
    expect(await run()).toBe('charged');
  });
});

describe('금액·크레딧', () => {
  it('pending_plan_id 가 있으면 새 플랜가·새 플랜 크레딧으로 청구하고 플랜을 전환한다', async () => {
    mockDb.masters.push({ plan_id: 'p2', plan_title: '프리미엄', actual_amount: 19900, credit: 30, is_del: 'N' });
    mockDb.plans[0].pending_plan_id = 'p2';
    okConfirm();

    const r = await run({ plan: { pending_plan_id: 'p2' } });

    expect(r).toBe('charged');
    expect(mockConfirm.mock.calls[0][0]).toMatchObject({ amount: 19900, orderName: '프리미엄' });
    expect(mockDb.payments[0]).toMatchObject({ plan_id: 'p2', amount: 19900, grant_credit: 30 });
    expect(mockDb.credits[0].credit).toBe(30);
    expect(dbPlan()).toMatchObject({ plan_id: 'p2', pending_plan_id: null, locked_amount: 19900, locked_credit: 30 });
  });

  it('예약이 없으면 가입 시점 고정값(locked_*)을 쓴다 — 현재 플랜가가 올라도 고정값', async () => {
    mockDb.masters[0].actual_amount = 12000;
    mockDb.masters[0].credit = 20;
    mockDb.plans[0].locked_amount = 5000;
    mockDb.plans[0].locked_credit = 5;
    okConfirm();

    await run({ plan: { locked_amount: 5000, locked_credit: 5 } });

    expect(mockConfirm.mock.calls[0][0].amount).toBe(5000);
    expect(mockDb.credits[0].credit).toBe(5);
  });

  it('locked_* 가 null(구 데이터)이면 현재 플랜가로 폴백', async () => {
    okConfirm();
    Object.assign(dbPlan(), { locked_amount: null, locked_credit: null }); // DB 와 스냅샷이 같아야 청구된다(H-1)
    await run({ plan: { locked_amount: null, locked_credit: null } });
    expect(mockConfirm.mock.calls[0][0].amount).toBe(9900);
    expect(mockDb.credits[0].credit).toBe(10);
  });

  it('크레딧 0 이면 lot·로그를 만들지 않는다', async () => {
    okConfirm();
    Object.assign(dbPlan(), { locked_credit: 0 });
    await run({ plan: { locked_credit: 0 } });
    expect(mockDb.credits).toHaveLength(0);
    expect(mockDb.creditLogs).toHaveLength(0);
    expect(mockDb.payments[0].status).toBe('DONE');
  });

  it.each([99, 0, null])('최종 금액이 100원 미만(%s)이면 청구하지 않고 오류 로그, 선점도 하지 않는다', async (amount) => {
    mockDb.masters[0].actual_amount = amount;
    const r = await run({ plan: { locked_amount: amount } });

    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
    expect(dbPlan().status).toBe('ACTIVE');
    expect(log.error).toHaveBeenCalled();
  });

  it('플랜 마스터를 찾을 수 없으면 청구하지 않고 구독 상태도 바꾸지 않는다', async () => {
    mockDb.masters = [];
    expect(await run()).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
  });
});

describe('빌링키·설정 사전 검증 — 청구 없이 건너뜀(상태 불변, 오류 로그)', () => {
  const expectNoCharge = async () => {
    const r = await run();
    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
    expect(dbPlan().status).toBe('ACTIVE');
    expect(log.error).toHaveBeenCalled();
  };

  it('암호문인데 BILLING_KEY_ENC_KEY 가 없음', async () => {
    mockConfig.billing.encKey = '';
    await expectNoCharge();
  });

  it.each(['pending:issuing', 'pending:issue-unknown', 'plain-legacy-key', ''])('enc:v1: 형식이 아닌 키(%s)', async (stored) => {
    const r = await run({ billing: { billing_key: stored } });
    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
    expect(dbPlan().status).toBe('ACTIVE');
    expect(log.error).toHaveBeenCalled();
  });

  it('복호화 실패(다른 키로 암호화됨) — 오류 로그에 암호문이 남지 않는다', async () => {
    const other = encrypt(PLAIN_KEY, 'another-secret');
    const r = await run({ billing: { billing_key: other } });
    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(logged()).not.toContain(other);
    expect(logged()).not.toContain(PLAIN_KEY);
  });

  it.each(['secretKey', 'merchantId'] as const)('다날 설정(%s)이 없음', async (field) => {
    mockConfig.danal[field] = '';
    await expectNoCharge();
  });

  it('next_charge_dt 가 없으면 건너뜀', async () => {
    const r = await run({ plan: { next_charge_dt: null } });
    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('카드가 비활성이면 청구하지 않고(결제 행 없음) 실패 상태로 전이한다', async () => {
    const r = await run({ billing: { is_active: 'N' } });
    expect(r).toBe('failed');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
    expect(dbPlan().status).toBe('PAST_DUE');
  });
});

describe('기록 형식', () => {
  it('선점 행에 member_plan_id·pg_provider·purchase_type·order_id 가 들어간다', async () => {
    mockConfirm.mockRejectedValue(new DanalResultUnknownError('timeout'));
    await run();
    expect(mockDb.payments[0]).toMatchObject({
      member_plan_id: 'mp1',
      pg_provider: 'danal',
      purchase_type: 'SUBSCRIPTION',
      order_id: `${K}_1`,
      member_id: 'm1',
      currency: 'KRW',
    });
  });

  it('주기 키는 next_charge_dt 문자열로 만든다(타임존 하루 밀림 없음)', async () => {
    mockDb.plans[0].next_charge_dt = '2026-12-01';
    okConfirm();
    await run({ plan: { next_charge_dt: '2026-12-01' } });
    expect(mockConfirm.mock.calls[0][0].orderId).toBe('sub_mp1_202612_1');
  });
});

// ====================================================================
// 07-subscription-review H-1 — 잡 시작 때 읽은 스냅샷을 믿지 않는다: 선점 트랜잭션에서 구독을 잠그고 다시 확인한다
describe('[H-1] 선점 시점 구독 재검증 — 조회 이후 DB 가 바뀌면 청구하지 않는다', () => {
  const dbChanged = (over: Row) => Object.assign(mockDb.plans[0], over);
  const untouched = () => {
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
    expect(mockDb.credits).toHaveLength(0);
  };

  it('조회 뒤 회원이 해지(CANCELED/is_active=N/next_charge_dt=NULL) → 다날 호출 없음, 해지 상태 유지', async () => {
    okConfirm();
    dbChanged({ status: 'CANCELED', is_active: 'N', next_charge_dt: null, canceled_at: new Date() });

    const r = await run(); // 스냅샷(planInDb)은 ACTIVE 그대로

    expect(r).toBe('skipped');
    untouched();
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
  });

  it('조회 뒤 구독이 삭제(is_del=Y)됨 → 청구하지 않는다', async () => {
    okConfirm();
    dbChanged({ is_del: 'Y' });
    expect(await run()).toBe('skipped');
    untouched();
  });

  it('조회 뒤 어드민이 비활성(is_active=N) 처리 → 청구하지 않는다', async () => {
    okConfirm();
    dbChanged({ is_active: 'N' });
    expect(await run()).toBe('skipped');
    untouched();
  });

  it('조회 뒤 결제일이 바뀜(다른 경로가 이미 전진) → 청구하지 않는다', async () => {
    okConfirm();
    dbChanged({ next_charge_dt: '2026-12-03' });
    expect(await run()).toBe('skipped');
    untouched();
  });

  it('조회 뒤 결제 카드가 교체됨 → 옛 카드로 청구하지 않는다', async () => {
    okConfirm();
    dbChanged({ member_billing_id: 'b2' });
    expect(await run()).toBe('skipped');
    untouched();
  });

  it('조회 뒤 플랜 변경이 예약됨 → 이전 플랜으로 청구하고 예약을 지우지 않도록 청구하지 않는다', async () => {
    okConfirm();
    dbChanged({ pending_plan_id: 'p2' });
    expect(await run()).toBe('skipped');
    untouched();
    expect(dbPlan().pending_plan_id).toBe('p2');
  });

  it('조회 뒤 상태가 PAST_DUE 로 바뀜(1차 잡 대상 아님) → 청구하지 않는다', async () => {
    okConfirm();
    dbChanged({ status: 'PAST_DUE' });
    expect(await run()).toBe('skipped');
    untouched();
  });

  it('구독 행이 사라졌으면 청구하지 않는다', async () => {
    okConfirm();
    mockDb.plans.length = 0;
    expect(await run()).toBe('skipped');
    untouched();
  });

  it('승인 도중 회원이 해지 → 지급하지 않고 보상 취소, 해지가 되살아나지 않는다', async () => {
    mockConfirm.mockImplementation(async (i: any) => {
      dbChanged({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
      return { transactionId: 'tx-1', orderId: i.orderId, amount: i.amount };
    });
    mockCancel.mockResolvedValue({ transactionId: 'cancel-1' });

    const r = await run();

    expect(r).toBe('failed');
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancel.mock.calls[0][0]).toMatchObject({ transactionId: 'tx-1', amount: 9900 });
    expect(mockDb.payments[0]).toMatchObject({ status: 'ABORTED', fail_code: 'GRANT_FAILED_CANCELED' });
    expect(mockDb.credits).toHaveLength(0);
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
  });

  it('승인 도중 구독이 삭제(is_del=Y)돼도 지급하지 않고 보상 취소', async () => {
    mockConfirm.mockImplementation(async (i: any) => {
      dbChanged({ is_del: 'Y' });
      return { transactionId: 'tx-1', orderId: i.orderId, amount: i.amount };
    });
    mockCancel.mockResolvedValue({ transactionId: 'cancel-1' });
    expect(await run()).toBe('failed');
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockDb.credits).toHaveLength(0);
  });

  it('보상 취소가 실패하면 결과 불명(CONFIRMING + GRANT_FAILED_CANCEL_FAILED)으로 남긴다', async () => {
    mockConfirm.mockImplementation(async (i: any) => {
      dbChanged({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
      return { transactionId: 'tx-1', orderId: i.orderId, amount: i.amount };
    });
    mockCancel.mockRejectedValue(new DanalApiError('CANCEL_FAIL', '취소 불가'));
    expect(await run()).toBe('unknown');
    expect(mockDb.payments[0]).toMatchObject({ status: 'CONFIRMING', fail_code: 'GRANT_FAILED_CANCEL_FAILED', pg_transaction_id: 'tx-1' });
  });

  it('재시도 잡: PAST_DUE 스냅샷이 DB 에서도 PAST_DUE 면 정상 청구된다 (회귀 방지)', async () => {
    okConfirm();
    dbChanged({ status: 'PAST_DUE' });
    expect(await run({ plan: { status: 'PAST_DUE' }, onFail: 'SUSPENDED' })).toBe('charged');
  });

  it('status 가 NULL 인 구독도 DB 와 같으면 청구된다 (1차 잡의 NULL 대상)', async () => {
    okConfirm();
    dbChanged({ status: null });
    expect(await run({ plan: { status: null } })).toBe('charged');
    expect(dbPlan().status).toBe('ACTIVE');
  });
});

// 07-subscription-review H-3 — 탈퇴 회원의 카드는 청구하지 않는다
describe('[H-3] 선점 트랜잭션에서 회원 탈퇴(is_del)를 확인한다', () => {
  it('회원이 탈퇴(is_del=Y)했으면 다날 호출 없이 건너뛰고 payment 를 만들지 않는다', async () => {
    okConfirm();
    mockDb.members = [{ member_id: 'm1', is_del: 'Y' }];

    const r = await run();

    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
    expect(dbPlan().status).toBe('ACTIVE'); // 구독 상태는 건드리지 않는다
  });

  it('회원 행이 없어도 청구하지 않는다 (fail-closed)', async () => {
    okConfirm();
    mockDb.members = [];
    expect(await run()).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('재시도 잡(PAST_DUE)도 탈퇴 회원이면 청구하지 않는다', async () => {
    okConfirm();
    mockDb.members = [{ member_id: 'm1', is_del: 'Y' }];
    mockDb.plans[0].status = 'PAST_DUE';
    expect(await run({ plan: { status: 'PAST_DUE' }, onFail: 'SUSPENDED' })).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(dbPlan().status).toBe('PAST_DUE');
  });
});
