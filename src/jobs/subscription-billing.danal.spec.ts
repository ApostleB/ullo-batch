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
const { MemberNotification } = require('../entities/member-notification.entity');

class FakeDb {
  payments: Row[] = [];
  plans: Row[] = [];
  credits: Row[] = [];
  creditLogs: Row[] = [];
  masters: Row[] = [];
  /** member_notification 행 — 구독 해지 알림(카카오 스텁) 기록 */
  notifications: Row[] = [];
  /** 알림 insert 가 던진다(알림 실패가 해지·결제를 깨뜨리지 않는지 확인) */
  failNotificationInsert = false;
  members: Row[] = [];
  /** member_suspension 행 (member_id, released_at, end_at) */
  suspensions: Row[] = [];
  /** payment_cancel 행 (payment_id, status) — 환불 진행 여부 조회용 */
  cancels: Row[] = [];
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
    if (e === MemberNotification) return this.notifications;
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
    // TypeORM IsNull() 연산자 — 값이 없는(null/undefined) 행만
    return Object.entries(where).every(([k, v]) => ((v as any)?._type === 'isNull' ? row[k] == null : row[k] === v));
  }

  private snapshot() {
    return structuredClone({ p: this.payments, pl: this.plans, c: this.credits, l: this.creditLogs, n: this.notifications });
  }

  private restore(s: ReturnType<FakeDb['snapshot']>) {
    this.payments = s.p;
    this.plans = s.pl;
    this.credits = s.c;
    this.creditLogs = s.l;
    this.notifications = s.n;
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
    const mgr: any = {
      query: async (sql: string, params: any[] = []) => {
        this.queries.push({ sql, params });
        if (sql.includes('pg_advisory_xact_lock')) return [];
        if (sql.includes('FROM payment WHERE order_id')) {
          const [key, pattern] = params as [string, string];
          const prefix = pattern.replace(/\\(.)/g, '$1').replace(/%$/, '');
          return this.payments
            .filter((p) => p.order_id === key || (p.order_id ?? '').startsWith(prefix))
            .map((p) => ({
              payment_id: p.payment_id,
              order_id: p.order_id,
              status: p.status,
              fail_code: p.fail_code ?? null,
              paid_at: p.paid_at ?? null,
              updated_at: p.updated_at ?? null,
            }));
        }
        if (sql.includes('FROM member_suspension')) {
          const [memberId, nowStr] = params as [string, string];
          const now = new Date(String(nowStr).replace(' ', 'T'));
          return this.suspensions
            .filter((x) => x.member_id === memberId && !x.released_at && (!x.end_at || x.end_at.getTime() > now.getTime()))
            .map(() => ({ one: 1 }));
        }
        if (sql.includes('FROM payment_cancel')) {
          const planId = params[0];
          const ids = this.payments.filter((p) => p.member_plan_id === planId).map((p) => p.payment_id);
          return this.cancels.filter((c) => ids.includes(c.payment_id) && ['PENDING', 'UNKNOWN'].includes(c.status)).map(() => ({ one: 1 }));
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
      insert: async (E: any, row: Row) => {
        if (E === MemberNotification && this.failNotificationInsert) throw new Error('알림 insert 실패(주입)');
        this.table(E).push({ ...row });
        return {};
      },
      // 중첩 transaction = SAVEPOINT — 콜백이 던지면 그 안의 변경(알림 행)만 되돌리고 던진다
      transaction: async (cb: (m: any) => Promise<any>) => {
        const snap = this.snapshot();
        try {
          return await cb(mgr);
        } catch (err) {
          this.restore(snap);
          throw err;
        }
      },
    };
    return mgr;
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
const run = (over: { plan?: Row; billing?: Row | null; onFail?: OnFailStatus } = {}) =>
  chargeDanalPlan(
    { ...planInDb, ...over.plan } as any,
    (over.billing === null ? null : billingRow(over.billing)) as any,
    over.onFail ?? 'PAST_DUE',
    log,
  );

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

// 날짜는 가짜 시계로 고정한다 — 픽스처 결제일(2026-11-03)이 "오늘"이 되게 해서 실제 날짜와 무관하게 같은 결과가 나온다.
// Date 만 가짜로 두고 타이머·마이크로태스크는 진짜를 쓴다(인메모리 DB 의 Promise 체인이 그대로 돈다).
const FAKE_NOW = new Date(2026, 10, 3, 21, 0, 0);
const setToday = (y: number, m: number, d: number) => jest.setSystemTime(new Date(y, m - 1, d, 21, 0, 0));

beforeEach(() => {
  jest.useFakeTimers({
    now: FAKE_NOW,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  jest.clearAllMocks();
  mockDb.payments = [];
  mockDb.plans = [];
  mockDb.credits = [];
  mockDb.creditLogs = [];
  mockDb.masters = [];
  mockDb.notifications = [];
  mockDb.failNotificationInsert = false;
  mockDb.members = [{ member_id: 'm1', is_del: 'N' }];
  mockDb.suspensions = [];
  mockDb.cancels = [];
  mockDb.queries = [];
  mockDb.failSaveOf = null;
  mockDb.throwAfterCommit = null;
  mockDb.failPaymentRead = false;
  mockConfig.danal.secretKey = 'fake-secret';
  mockConfig.danal.merchantId = 'fake-merchant';
  mockConfig.billing.encKey = ENC_SECRET;
  seed();
});

afterEach(() => {
  jest.useRealTimers();
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

  it('PAST_DUE 였던 구독도 DONE 이 있으면 ACTIVE 로 돌아오며 결제일이 전진한다 (백엔드 재청구와 같은 동작) [M-2]', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    mockDb.payments.push(row(`${K}_1`, 'DONE'));
    await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' });
    expect(dbPlan().status).toBe('ACTIVE');
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-03');
  });

  it('결제일(과 이용기간)만 전진하고 플랜 전환·예약 해제·고정가 갱신은 하지 않는다 — 어느 플랜으로 결제됐는지 모른다 [M-2]', async () => {
    mockDb.masters.push({ plan_id: 'p2', plan_title: '프리미엄', actual_amount: 19900, credit: 30, is_del: 'N', is_active: 'Y', plan_type: 'SUBSCRIPTION' });
    Object.assign(dbPlan(), { pending_plan_id: 'p2' });
    mockDb.payments.push(row(`${K}_1`, 'DONE'));

    const r = await run({ plan: { pending_plan_id: 'p2' } });

    expect(r).toBe('skipped');
    expect(dbPlan()).toMatchObject({ plan_id: 'p1', pending_plan_id: 'p2', locked_amount: 9900, locked_credit: 10 });
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-03');
  });

  it('밀린 주기에 DONE 이 있으면 그 결제의 실제 청구일(paid_at) + 1개월, 이미 지났으면 오늘 + 1개월 — 과거 결제일이 남지 않는다 [N-4]', async () => {
    Object.assign(dbPlan(), { next_charge_dt: '2026-08-15' });
    mockDb.payments.push(row('sub_mp1_202608_1', 'DONE', { paid_at: new Date(2026, 7, 15, 21, 0, 0) }));

    await run({ plan: { next_charge_dt: '2026-08-15' } });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-03');
  });

  it('최근(어제) 결제된 주기면 어제 + 1개월 = 12-02 로 잡는다 [N-4]', async () => {
    Object.assign(dbPlan(), { next_charge_dt: '2026-11-01' });
    mockDb.payments.push(row('sub_mp1_202611_1', 'DONE', { paid_at: new Date(2026, 10, 2, 21, 0, 0) }));

    await run({ plan: { next_charge_dt: '2026-11-01' } });

    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-02');
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
    setToday(2027, 1, 31);
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

// 10 P-1 — 카드 거절이 아닌 다날 오류(HTTP 2xx 외, 가맹점·인증·계약 코드)는 구독 상태를 바꾸지 않고 시스템 오류로 기록한다.
describe('[P-1] 카드 거절이 아닌 다날 오류는 거절로 전이하지 않는다', () => {
  const nonCard = [
    ['HTTP 401', () => new DanalApiError('E100', '인증 실패', 401)],
    ['HTTP 403', () => new DanalApiError('E100', '권한 없음', 403)],
    ['HTTP 429', () => new DanalApiError('E100', '호출 한도', 429)],
    ['HTTP 400', () => new DanalApiError('INVALID_REQUEST', '요청 오류', 400)],
    ['HTTP 200 + 가맹점 코드', () => new DanalApiError('MERCHANT_NOT_FOUND', '가맹점 없음', 200)],
  ] as const;

  it.each(nonCard)('%s — 1차 잡: ABORTED+SYSTEM_ERROR, 구독은 ACTIVE 그대로(PAST_DUE 로도 바꾸지 않는다), 해지 알림 없음', async (_n, make) => {
    mockConfirm.mockRejectedValue(make());

    const r = await run({ onFail: 'PAST_DUE' });

    expect(r).toBe('system_error');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockDb.payments).toHaveLength(1);
    expect(mockDb.payments[0]).toMatchObject({ order_id: `${K}_1`, status: 'ABORTED', fail_code: 'SYSTEM_ERROR' });
    expect(String(mockDb.payments[0].fail_reason)).toContain('다날 요청 거부');
    expect(dbPlan()).toMatchObject({ status: 'ACTIVE', is_active: 'Y' });
    expect(String(dbPlan().next_charge_dt).slice(0, 10)).toBe('2026-11-03');
    expect(mockDb.notifications).toHaveLength(0);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it.each(nonCard)('%s — 재시도 잡(onFail=CANCELED): PAST_DUE 를 해지하지 않는다 (재현: 비밀키 오교체로 이틀 만에 전부 해지)', async (_n, make) => {
    mockDb.plans[0].status = 'PAST_DUE';
    mockConfirm.mockRejectedValue(make());

    const r = await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' });

    expect(r).toBe('system_error');
    expect(dbPlan()).toMatchObject({ status: 'PAST_DUE', is_active: 'Y' });
    expect(String(dbPlan().next_charge_dt).slice(0, 10)).toBe('2026-11-03');
    expect(dbPlan().canceled_at).toBeNull();
    expect(mockDb.notifications).toHaveLength(0);
    expect(mockDb.payments[0]).toMatchObject({ status: 'ABORTED', fail_code: 'SYSTEM_ERROR' });
  });

  it('같은 주기를 다음 실행에서 다음 시도 번호(_2)로 다시 청구한다 — 중복 청구 없이 (주기 키 규칙 유지)', async () => {
    mockConfirm.mockRejectedValueOnce(new DanalApiError('E100', '인증 실패', 401));
    expect(await run()).toBe('system_error');

    okConfirm();
    expect(await run()).toBe('charged');

    expect(mockDb.payments.map((p) => [p.order_id, p.status])).toEqual([
      [`${K}_1`, 'ABORTED'],
      [`${K}_2`, 'DONE'],
    ]);
    expect(mockConfirm).toHaveBeenCalledTimes(2);
  });

  it('비카드 오류 로그는 [CRITICAL] 이며 빌링키·비밀키가 없다', async () => {
    mockConfirm.mockRejectedValue(new DanalApiError('E100', '인증 실패', 401));
    await run();
    expect(JSON.stringify(log.error.mock.calls)).toContain('[CRITICAL]');
    expect(logged()).not.toContain(PLAIN_KEY);
    expect(logged()).not.toContain('fake-secret');
  });
});

// 10 P-5 — 같은 날 두 번째 거절로 해지되지 않는다 (배치 재시도 잡). 백엔드 어드민 수동 청구와 같은 판정(subscription-retry-guard.util).
describe('[P-5] 다음 날 재시도 강제', () => {
  const declinedRow = (day: number, hour = 19) =>
    row(`${K}_1`, 'ABORTED', { fail_code: 'CARD_LIMIT', updated_at: new Date(2026, 10, day, hour, 50, 0) });

  it('재현: 19:50 수동 청구가 거절 전이시킨 PAST_DUE 를 20:00 재시도 잡이 같은 날 청구하지 않는다 — 다날 호출·결제 행·해지 없음', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    mockDb.payments.push(declinedRow(3));
    mockConfirm.mockRejectedValue(new DanalApiError('CARD_LIMIT', '한도 초과'));

    const r = await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' });

    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(1);
    expect(dbPlan()).toMatchObject({ status: 'PAST_DUE', is_active: 'Y' });
    expect(mockDb.notifications).toHaveLength(0);
  });

  it('어제 거절 전이된 PAST_DUE 는 재시도한다 (거절이면 해지)', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    mockDb.payments.push(declinedRow(2, 21));
    mockConfirm.mockRejectedValue(new DanalApiError('CARD_LIMIT', '한도 초과'));

    const r = await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' });

    expect(r).toBe('declined');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N' });
  });

  it('결제 행이 없는 비활성 카드로 오늘 PAST_DUE 가 된 구독은 오늘 다시 전이(해지)하지 않는다 (구독 갱신 시각)', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    mockDb.plans[0].updated_at = new Date(2026, 10, 3, 9, 0, 0);

    const r = await run({ plan: { status: 'PAST_DUE', updated_at: new Date(2026, 10, 3, 9, 0, 0) }, billing: { is_active: 'N' }, onFail: 'CANCELED' });

    expect(r).toBe('skipped');
    expect(dbPlan()).toMatchObject({ status: 'PAST_DUE', is_active: 'Y' });
    expect(mockDb.notifications).toHaveLength(0);
  });

  it('비활성 카드로 어제 PAST_DUE 가 된 구독은 재시도 잡에서 해지된다', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    mockDb.plans[0].updated_at = new Date(2026, 10, 2, 21, 0, 0);

    const r = await run({ plan: { status: 'PAST_DUE', updated_at: new Date(2026, 10, 2, 21, 0, 0) }, billing: { is_active: 'N' }, onFail: 'CANCELED' });

    expect(r).toBe('failed');
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N' });
  });

  it('오늘 시스템 오류(ABORTED+SYSTEM_ERROR)만 새로 생겼고 거절 전이는 어제인 PAST_DUE 는 다시 청구한다', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    mockDb.payments.push(declinedRow(2, 21), row(`${K}_2`, 'ABORTED', { fail_code: 'SYSTEM_ERROR', updated_at: new Date(2026, 10, 3, 9, 0, 0) }));
    okConfirm();

    const r = await run({ plan: { status: 'PAST_DUE', updated_at: new Date(2026, 10, 3, 9, 0, 0) }, onFail: 'CANCELED' });

    expect(r).toBe('charged');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('ACTIVE 구독에는 적용하지 않는다 (오늘 첫 청구)', async () => {
    mockDb.plans[0].updated_at = new Date(2026, 10, 3, 9, 0, 0);
    okConfirm();
    expect(await run({ plan: { updated_at: new Date(2026, 10, 3, 9, 0, 0) } })).toBe('charged');
  });
});

describe('[T5] 다날이 거절(DanalApiError) → ABORTED + 구독 상태 전이', () => {
  beforeEach(() => mockConfirm.mockRejectedValue(new DanalApiError('CARD_LIMIT', '한도 초과')));

  it('1차 잡: 선점 행을 ABORTED(fail_code=err.code) 로 갱신하고 PAST_DUE. 별도 _fail_ 행은 만들지 않는다', async () => {
    const r = await run({ onFail: 'PAST_DUE' });

    expect(r).toBe('declined');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockDb.payments).toHaveLength(1);
    expect(mockDb.payments[0]).toMatchObject({ order_id: `${K}_1`, status: 'ABORTED', fail_code: 'CARD_LIMIT', fail_reason: '한도 초과' });
    expect(mockDb.payments.some((p) => (p.order_id ?? '').includes('_fail_'))).toBe(false);
    expect(dbPlan().status).toBe('PAST_DUE');
    expect(dbPlan().is_active).toBe('Y');
    expect(mockDb.credits).toHaveLength(0);
  });

  it('재시도 잡: 실패하면 SUSPENDED 가 아니라 해지(CANCELED, 비활성, 다음 결제 없음) — 지급된 크레딧은 그대로 [정책1]', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    mockDb.credits.push({ member_credit_id: 'c-old', member_id: 'm1', credit: 10, is_del: 'N' });

    const r = await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' });

    expect(r).toBe('declined');
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
    expect(dbPlan().canceled_at).toBeInstanceOf(Date);
    expect(mockDb.payments[0]).toMatchObject({ status: 'ABORTED', fail_code: 'CARD_LIMIT' });
    expect(mockDb.credits).toEqual([{ member_credit_id: 'c-old', member_id: 'm1', credit: 10, is_del: 'N' }]); // 기존 크레딧 유지
  });

  it('[N-2 R1] 1차 잡: 다날 호출 중 회원이 해지한 뒤 카드가 거절돼도 PAST_DUE 로 덮어쓰지 않는다 — 해지 상태 유지', async () => {
    mockConfirm.mockImplementation(async () => {
      Object.assign(mockDb.plans[0], { status: 'CANCELED', is_active: 'N', next_charge_dt: null, canceled_at: new Date() });
      throw new DanalApiError('CARD_LIMIT', '한도 초과');
    });

    expect(await run({ onFail: 'PAST_DUE' })).toBe('declined');

    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
    expect(mockDb.payments[0]).toMatchObject({ status: 'ABORTED', fail_code: 'CARD_LIMIT' }); // 결제 행은 닫는다
  });

  it('[N-2 R2] 재시도 잡: 다날 호출 중 해지된 구독은 거절돼도 상태·해지 시각을 덮어쓰지 않는다', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    const canceledAt = new Date(2026, 10, 3, 20, 59, 0);
    mockConfirm.mockImplementation(async () => {
      Object.assign(mockDb.plans[0], { status: 'CANCELED', is_active: 'N', next_charge_dt: null, canceled_at: canceledAt });
      throw new DanalApiError('CARD_LIMIT', '한도 초과');
    });

    await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' });

    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
    expect(dbPlan().canceled_at).toBe(canceledAt);
  });

  it('[N-2] 다날 호출 중 어드민이 비활성(is_active=N)으로 멈춘 구독도 거절 후 PAST_DUE 로 바꾸지 않는다', async () => {
    mockConfirm.mockImplementation(async () => {
      mockDb.plans[0].is_active = 'N';
      throw new DanalApiError('CARD_LIMIT', '한도 초과');
    });

    await run({ onFail: 'PAST_DUE' });

    expect(dbPlan()).toMatchObject({ status: 'ACTIVE', is_active: 'N' });
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

    const r = await run({ onFail: 'CANCELED' });

    expect(r).toBe('failed');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockCancel.mock.calls[0][0]).toMatchObject({ transactionId: 'tx-1', amount: 9900, cancelType: 'C' });
    expect(mockDb.payments[0]).toMatchObject({ status: 'ABORTED', fail_code: 'CONFIRM_MISMATCH_CANCELED' });
    expect(dbPlan().status).toBe('ACTIVE'); // 카드 문제가 아니므로 PAST_DUE/CANCELED 로 만들지 않는다
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

describe('[T11][정책3] 이전 PG 카드(INICIS·TOSS·NULL 등)는 결제일에 청구하지 않고 구독을 해지한다', () => {
  it.each([
    ['INICIS', 'INICIS'],
    ['inicis(소문자)', 'inicis'],
    ['NULL', null],
    ['TOSS', 'TOSS'],
    ['빈 문자열', ''],
    ['알 수 없는 값', 'KCP'],
  ])('%s → 다날 호출·결제 행 없이 CANCELED(비활성, canceled_at, 다음 결제일 NULL), 오류 없음', async (_name, provider) => {
    const r = await run({ billing: { provider } });

    expect(r).toBe('canceled');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0); // 실패 행이 쌓이지 않는다
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
    expect(dbPlan().canceled_at).toBeInstanceOf(Date);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('카드 정보가 없는 구독(member_billing_id 없음/카드 행 없음)도 청구할 수 없으므로 해지한다', async () => {
    const r = await run({ billing: null });
    expect(r).toBe('canceled');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N' });
  });

  it('재시도 잡(PAST_DUE) 에서 만나도 같다 — 해지', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    expect(await run({ plan: { status: 'PAST_DUE' }, billing: { provider: 'INICIS' }, onFail: 'CANCELED' })).toBe('canceled');
    expect(dbPlan().status).toBe('CANCELED');
    expect(mockDb.payments).toHaveLength(0);
  });

  it('결제일이 아직 오지 않았으면 해지하지 않는다 — 카드 교체 시간을 준다', async () => {
    Object.assign(dbPlan(), { next_charge_dt: '2026-11-20' });
    expect(await run({ plan: { next_charge_dt: '2026-11-20' }, billing: { provider: 'INICIS' } })).toBe('skipped');
    expect(dbPlan().status).toBe('ACTIVE');
  });

  it('조회 뒤 카드가 다날 카드로 교체됐다면(스냅샷과 DB 불일치) 옛 카드 기준으로 해지하지 않는다', async () => {
    Object.assign(dbPlan(), { member_billing_id: 'b-new' });
    expect(await run({ billing: { provider: 'INICIS' } })).toBe('skipped');
    expect(dbPlan()).toMatchObject({ status: 'ACTIVE', is_active: 'Y', next_charge_dt: '2026-11-03' });
  });

  it('조회 뒤 회원이 이미 해지했다면 해지 시각을 덮어쓰지 않는다', async () => {
    const at = new Date(2026, 10, 1);
    Object.assign(dbPlan(), { status: 'CANCELED', is_active: 'N', next_charge_dt: null, canceled_at: at });
    expect(await run({ billing: { provider: 'INICIS' } })).toBe('skipped');
    expect(dbPlan().canceled_at).toBe(at);
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
    mockDb.masters.push({ plan_id: 'p2', plan_title: '프리미엄', actual_amount: 19900, credit: 30, is_del: 'N', is_active: 'Y', plan_type: 'SUBSCRIPTION' });
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
    setToday(2026, 12, 1); // 결제일이 도래해야 청구된다
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
    expect(await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' })).toBe('charged');
  });

  it('status 가 NULL 인 구독도 DB 와 같으면 청구된다 (1차 잡의 NULL 대상)', async () => {
    okConfirm();
    dbChanged({ status: null });
    expect(await run({ plan: { status: null } })).toBe('charged');
    expect(dbPlan().status).toBe('ACTIVE');
  });
});

// 07-subscription-review H-3 / D-4 — 탈퇴 회원의 열린 구독은 청구하지 않고 알림 없이 해지한다
describe('[H-3][D-4] 탈퇴 회원(member.is_del=Y 또는 회원 행 없음)의 구독은 청구하지 않고 알림 없이 해지한다', () => {
  const expectCanceledSilently = () => {
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
    expect(dbPlan().canceled_at).toBeInstanceOf(Date);
    expect(mockDb.notifications).toHaveLength(0); // 탈퇴 회원에게 KAKAO_STUB 알림을 남기지 않는다
  };

  it('다날 카드 구독: 다날 호출·결제 행 없이 CANCELED 로 해지한다 (이전에는 skipped 로 영구히 남았다)', async () => {
    okConfirm();
    mockDb.members = [{ member_id: 'm1', is_del: 'Y' }];
    expect(await run()).toBe('canceled');
    expectCanceledSilently();
  });

  it('회원 행이 없어도(fail-closed) 청구하지 않고 해지한다', async () => {
    okConfirm();
    mockDb.members = [];
    expect(await run()).toBe('canceled');
    expectCanceledSilently();
  });

  it('재시도 잡(PAST_DUE)도 탈퇴 회원이면 청구하지 않고 해지한다', async () => {
    okConfirm();
    mockDb.members = [{ member_id: 'm1', is_del: 'Y' }];
    mockDb.plans[0].status = 'PAST_DUE';
    expect(await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' })).toBe('canceled');
    expectCanceledSilently();
  });

  it('이전 PG 카드 구독: 탈퇴 회원이면 OLD_PG_CARD 알림 없이 해지한다 (보고서 D-4 — be111111 재현)', async () => {
    mockDb.members = [{ member_id: 'm1', is_del: 'Y' }];
    mockDb.plans[0].status = 'PAST_DUE';
    expect(await run({ plan: { status: 'PAST_DUE' }, billing: { provider: 'INICIS' }, onFail: 'CANCELED' })).toBe('canceled');
    expectCanceledSilently();
  });

  it('카드 정보가 없는 구독도 탈퇴 회원이면 알림 없이 해지한다', async () => {
    mockDb.members = [{ member_id: 'm1', is_del: 'Y' }];
    expect(await run({ billing: null })).toBe('canceled');
    expectCanceledSilently();
  });

  it('탈퇴하지 않은 회원의 이전 PG 구독은 기존대로 OLD_PG_CARD 알림과 함께 해지한다', async () => {
    expect(await run({ billing: { provider: 'INICIS' } })).toBe('canceled');
    expect(mockDb.notifications.map((n) => n.link)).toEqual(['subscription/mp1?reason=OLD_PG_CARD']);
  });

  it('활성 정지 회원이 탈퇴했으면 탈퇴가 먼저다 — 정지 해지 알림도 남기지 않는다', async () => {
    mockDb.members = [{ member_id: 'm1', is_del: 'Y' }];
    mockDb.suspensions.push({ member_id: 'm1', released_at: null, end_at: null });
    expect(await run()).toBe('canceled');
    expectCanceledSilently();
  });

  it('조회 뒤 구독이 바뀌었으면(카드 교체) 탈퇴 회원이어도 해지하지 않는다', async () => {
    mockDb.members = [{ member_id: 'm1', is_del: 'Y' }];
    Object.assign(dbPlan(), { member_billing_id: 'b-new' });
    expect(await run({ billing: { provider: 'INICIS' } })).toBe('skipped');
    expect(dbPlan()).toMatchObject({ status: 'ACTIVE', is_active: 'Y' });
  });

  it('결제일이 아직 오지 않았으면 탈퇴 회원이어도 건드리지 않는다', async () => {
    Object.assign(dbPlan(), { next_charge_dt: '2026-11-20' });
    mockDb.members = [{ member_id: 'm1', is_del: 'Y' }];
    expect(await run({ plan: { next_charge_dt: '2026-11-20' } })).toBe('skipped');
    expect(dbPlan().status).toBe('ACTIVE');
  });
});

// ====================================================================
// 정책 4 — 배치가 못 돈 날: 다음 실행 때 지난 주기를 "한 번만" 청구하고, 다음 결제일은 실제 청구일 + 1개월이다.
// (이전의 "이용기간이 끝난 주기는 청구 없이 재설정" 규칙과 이틀 연속 청구[N-4]를 대체한다)
describe('[정책4][N-4] 밀린 결제일 — 지난 주기를 한 번만 청구하고 다음 결제일은 실제 청구일 + 1개월', () => {
  const overdue = (over: Row = {}): Row => ({ next_charge_dt: '2026-08-15', ...over });
  /** 잡이 매번 DB 에서 다시 읽는 것을 흉내 낸다 */
  const runFromDb = (onFail: OnFailStatus = 'PAST_DUE') => run({ plan: { ...dbPlan() }, onFail });

  it('R4 재현: 이니시스였다가 카드 교체된 10-15 주기를 11-14 에 만나면 1회 청구하고 다음은 12-14 — 다음 날(11-15) 다시 청구하지 않는다', async () => {
    Object.assign(dbPlan(), overdue({ next_charge_dt: '2026-10-15' }));
    okConfirm();
    setToday(2026, 11, 14);

    expect(await runFromDb()).toBe('charged');
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-14');

    setToday(2026, 11, 15);
    expect(await runFromDb()).toBe('skipped'); // 결제일이 아직 오지 않음
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockDb.payments.map((p) => p.order_id)).toEqual(['sub_mp1_202610_1']);
  });

  it('R5 재현: 2027-01-31 주기를 02-27 에 처리하면 다음은 03-27 — 02-28 에 또 청구하지 않는다', async () => {
    Object.assign(dbPlan(), overdue({ next_charge_dt: '2027-01-31' }));
    okConfirm();
    setToday(2027, 2, 27);

    expect(await runFromDb()).toBe('charged');
    expect(ymd(dbPlan().next_charge_dt)).toBe('2027-03-27');

    setToday(2027, 2, 28);
    expect(await runFromDb()).toBe('skipped');
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('3개월 밀린 ACTIVE 구독도 청구 없이 재설정하지 않는다 — 지난 주기(08월 키)를 한 번 청구하고 다음 결제일은 오늘 + 1개월', async () => {
    Object.assign(dbPlan(), overdue());
    okConfirm();

    expect(await runFromDb()).toBe('charged');

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockDb.payments).toHaveLength(1);
    expect(mockDb.payments[0]).toMatchObject({ order_id: 'sub_mp1_202608_1', status: 'DONE' });
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-03');
    expect(ymd(dbPlan().end_dt)).toBe('2026-12-03');
    expect(mockDb.credits).toHaveLength(1);

    // 3일 연속 실행해도 더 청구하지 않는다
    for (const day of [4, 5]) {
      setToday(2026, 11, day);
      expect(await runFromDb()).toBe('skipped');
    }
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });

  it('하루 늦은 구독(어제 결제일)은 오늘 청구하고 다음 결제일은 오늘 + 1개월(12-03)이다', async () => {
    Object.assign(dbPlan(), overdue({ next_charge_dt: '2026-11-02' }));
    okConfirm();
    expect(await runFromDb()).toBe('charged');
    expect(mockDb.payments[0].order_id).toBe('sub_mp1_202611_1');
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-03');
  });

  it('제때 처리하면(결제일 당일) 다음 결제일은 같은 날짜 +1개월이다', async () => {
    okConfirm();
    expect(await run()).toBe('charged');
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-03');
  });

  it('밀린 PAST_DUE 를 재시도 잡이 만나도 청구한다(재설정·ACTIVE 복귀 없음). 성공하면 ACTIVE', async () => {
    Object.assign(dbPlan(), overdue({ status: 'PAST_DUE' }));
    okConfirm();
    expect(await runFromDb('CANCELED')).toBe('charged');
    expect(dbPlan()).toMatchObject({ status: 'ACTIVE', is_active: 'Y' });
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-03');
  });

  it('이용기간(end_dt)은 청구에 성공했을 때만 늘어난다', async () => {
    Object.assign(dbPlan(), overdue({ end_dt: '2026-08-15' }));
    mockConfirm.mockRejectedValue(new DanalApiError('CARD_LIMIT', '한도 초과'));
    await runFromDb();
    expect(String(dbPlan().end_dt).slice(0, 10)).toBe('2026-08-15');
  });

  it('밀린 주기에 CONFIRMING(결과 불명)이 있으면 청구하지 않는다 — 어드민 GRANT 해소가 주기 키를 맞춰야 한다', async () => {
    Object.assign(dbPlan(), overdue());
    mockDb.payments.push(row('sub_mp1_202608_1', 'CONFIRMING', { fail_code: 'CONFIRM_UNKNOWN' }));
    const before = JSON.stringify(mockDb.plans);

    expect(await runFromDb()).toBe('skipped');

    expect(JSON.stringify(mockDb.plans)).toBe(before);
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('조회 뒤 회원이 해지했다면 청구하지도, 되살리지도 않는다 (H-1)', async () => {
    const snapshot = { ...planInDb, ...overdue() };
    Object.assign(dbPlan(), overdue(), { status: 'CANCELED', is_active: 'N', next_charge_dt: null });

    await run({ plan: snapshot });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
  });

  it('결제일이 아직 오지 않은 구독은 청구하지 않는다 — 재시도 잡이 12월분을 미리 청구하던 문제 [M-2]', async () => {
    Object.assign(dbPlan(), { status: 'PAST_DUE', next_charge_dt: '2026-11-04' });
    const before = JSON.stringify(mockDb.plans);

    expect(await runFromDb('CANCELED')).toBe('skipped');

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
    expect(JSON.stringify(mockDb.plans)).toBe(before);
  });

  it('기존 DB 의 SUSPENDED 행은 오류 없이 다룬다 — 어느 잡도 조회하지 않고, 직접 넘어와도 청구하지 않는다(상태 불변)', async () => {
    Object.assign(dbPlan(), { status: 'SUSPENDED', is_active: 'N' });
    const before = JSON.stringify(mockDb.plans);

    const r = await runFromDb();

    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(JSON.stringify(mockDb.plans)).toBe(before);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('로그에 빌링키가 남지 않는다', async () => {
    Object.assign(dbPlan(), overdue());
    okConfirm();
    await runFromDb();
    expect(logged()).not.toContain(PLAIN_KEY);
  });
});

// 정책 1 — 결제 실패: 결제일 청구 실패 → PAST_DUE, 다음 날 재시도 1회, 재시도 실패 → 해지(CANCELED)
describe('[정책1] 결제 실패 → PAST_DUE → 재시도 실패 시 해지', () => {
  it('1차 실패는 PAST_DUE 이고 결제일은 그대로 남는다(재시도 잡이 같은 주기 키로 재시도)', async () => {
    mockConfirm.mockRejectedValue(new DanalApiError('CARD_LIMIT', '한도 초과'));
    expect(await run({ onFail: 'PAST_DUE' })).toBe('declined');
    expect(dbPlan()).toMatchObject({ status: 'PAST_DUE', is_active: 'Y', next_charge_dt: '2026-11-03' });
  });

  it('다음 날 재시도 성공 → ACTIVE, 같은 주기 키의 2번째 시도(K_2), 다음 결제일은 재시도일 + 1개월', async () => {
    mockConfirm.mockRejectedValueOnce(new DanalApiError('CARD_LIMIT', '한도 초과'));
    await run({ onFail: 'PAST_DUE' });
    setToday(2026, 11, 4);
    okConfirm();

    expect(await run({ plan: { ...dbPlan() }, onFail: 'CANCELED' })).toBe('charged');

    expect(mockDb.payments.map((p) => [p.order_id, p.status])).toEqual([
      [`${K}_1`, 'ABORTED'],
      [`${K}_2`, 'DONE'],
    ]);
    expect(dbPlan()).toMatchObject({ status: 'ACTIVE', is_active: 'Y' });
    expect(ymd(dbPlan().next_charge_dt)).toBe('2026-12-04');
  });

  it('다음 날 재시도도 거절 → 구독 해지, 이후 어떤 잡도 청구하지 않는다', async () => {
    mockConfirm.mockRejectedValue(new DanalApiError('CARD_LIMIT', '한도 초과'));
    await run({ onFail: 'PAST_DUE' });
    setToday(2026, 11, 4);

    expect(await run({ plan: { ...dbPlan() }, onFail: 'CANCELED' })).toBe('declined');

    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
    expect(mockConfirm).toHaveBeenCalledTimes(2);
    // 해지된 구독을 스냅샷으로 다시 넘겨도 청구하지 않는다
    expect(await run({ plan: { ...planInDb, status: 'PAST_DUE' }, onFail: 'CANCELED' })).toBe('skipped');
    expect(mockConfirm).toHaveBeenCalledTimes(2);
  });

  it('재시도에서 결과 불명이면 해지하지 않고 PAST_DUE·CONFIRMING 으로 남긴다(어드민 해소)', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    mockConfirm.mockRejectedValue(new DanalResultUnknownError('timeout'));
    expect(await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' })).toBe('unknown');
    expect(dbPlan()).toMatchObject({ status: 'PAST_DUE', is_active: 'Y' });
  });

  it('[N-2 R9] 비활성 카드 + 밀린 구독: 청구 없이 실패 전이하되 해지·탈퇴 확인 뒤에 한다 (PAST_DUE, 다음 날 해지)', async () => {
    Object.assign(dbPlan(), { next_charge_dt: '2026-08-15' });
    expect(await run({ plan: { next_charge_dt: '2026-08-15' }, billing: { is_active: 'N' }, onFail: 'PAST_DUE' })).toBe('failed');
    expect(dbPlan().status).toBe('PAST_DUE');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);

    setToday(2026, 11, 4);
    expect(await run({ plan: { ...dbPlan() }, billing: { is_active: 'N' }, onFail: 'CANCELED' })).toBe('failed');
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
  });

  it('[N-2 R10][D-4] 비활성 카드 + 탈퇴 회원: PAST_DUE 로 전이하지 않고 알림 없이 해지한다', async () => {
    mockDb.members[0].is_del = 'Y';
    expect(await run({ billing: { is_active: 'N' } })).toBe('canceled');
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
    expect(mockDb.notifications).toHaveLength(0);
  });

  it('[N-2 R3] 비활성 카드 + 조회 뒤 해지된 구독: 해지 상태를 PAST_DUE 로 덮어쓰지 않는다', async () => {
    Object.assign(dbPlan(), { status: 'CANCELED', is_active: 'N', next_charge_dt: null });
    expect(await run({ billing: { is_active: 'N' } })).toBe('skipped');
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
  });
});

// 정책 2 — 정지 회원: 안전장치로 선점 시 활성 정지를 확인해 청구하지 않고 해지한다
describe('[정책2] 정지 회원은 청구하지 않고 구독을 해지한다 (선점 시 확인)', () => {
  const suspension = (over: Row = {}): Row => ({ member_id: 'm1', released_at: null, end_at: null, ...over });

  it('무기한 정지 → 다날 호출·결제 행 없이 구독 CANCELED', async () => {
    mockDb.suspensions.push(suspension());
    okConfirm();

    expect(await run()).toBe('canceled');

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
    expect(dbPlan().canceled_at).toBeInstanceOf(Date);
  });

  it('종료 시각이 미래인 기간 정지도 막는다', async () => {
    mockDb.suspensions.push(suspension({ end_at: new Date(2026, 10, 10) }));
    expect(await run()).toBe('canceled');
  });

  it.each([
    ['해제됨', { released_at: new Date(2026, 10, 2) }],
    ['기간 만료', { end_at: new Date(2026, 10, 3, 0, 0, 0) }],
  ])('%s 정지는 막지 않는다', async (_name, over) => {
    mockDb.suspensions.push(suspension(over));
    okConfirm();
    expect(await run()).toBe('charged');
  });

  it('다른 회원의 정지는 영향을 주지 않는다', async () => {
    mockDb.suspensions.push(suspension({ member_id: 'other' }));
    okConfirm();
    expect(await run()).toBe('charged');
  });

  it('재시도 잡(PAST_DUE)도 정지 회원이면 해지한다', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    mockDb.suspensions.push(suspension());
    expect(await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' })).toBe('canceled');
    expect(dbPlan().status).toBe('CANCELED');
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('조회 뒤 이미 해지된 구독은 해지 시각을 덮어쓰지 않는다 (stale 우선)', async () => {
    const at = new Date(2026, 10, 1);
    mockDb.suspensions.push(suspension());
    Object.assign(dbPlan(), { status: 'CANCELED', is_active: 'N', next_charge_dt: null, canceled_at: at });
    expect(await run()).toBe('skipped');
    expect(dbPlan().canceled_at).toBe(at);
  });

  it('승인 도중 정지 서비스가 구독을 해지하면(회원 락 직렬화 뒤) 지급하지 않고 보상 취소한다', async () => {
    mockConfirm.mockImplementation(async (i: any) => {
      Object.assign(mockDb.plans[0], { status: 'CANCELED', is_active: 'N', next_charge_dt: null, canceled_at: new Date() });
      return { transactionId: 'tx-1', orderId: i.orderId, amount: i.amount };
    });
    mockCancel.mockResolvedValue({ transactionId: 'cancel-1' });

    expect(await run()).toBe('failed');

    expect(mockCancel).toHaveBeenCalledTimes(1);
    expect(mockDb.credits).toHaveLength(0);
    expect(dbPlan().status).toBe('CANCELED');
  });
});

// N-5 — 환불 결과 불명·미확정 동안 다음 주기를 청구하지 않는다
describe('[N-5] 환불 진행(PENDING)·결과 불명(UNKNOWN) 중인 구독은 청구하지 않는다', () => {
  it.each(['PENDING', 'UNKNOWN'])('이 구독의 결제에 payment_cancel %s 가 있으면 다날 호출·선점 없이 건너뛴다', async (status) => {
    mockDb.payments.push(row('sub_mp1_202610_1', 'DONE', { member_plan_id: 'mp1', purchase_type: 'SUBSCRIPTION' }));
    mockDb.cancels.push({ payment_id: 'seed-sub_mp1_202610_1', status });
    okConfirm();

    expect(await run()).toBe('skipped');

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(1);
    expect(dbPlan()).toMatchObject({ status: 'ACTIVE', is_active: 'Y' });
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('[CRITICAL]'));
  });

  it('완료(DONE)된 환불은 막지 않는다 — 구독 해지는 환불 확정 트랜잭션이 맡는다', async () => {
    mockDb.payments.push(row('sub_mp1_202610_1', 'DONE', { member_plan_id: 'mp1' }));
    mockDb.cancels.push({ payment_id: 'seed-sub_mp1_202610_1', status: 'DONE' });
    okConfirm();
    expect(await run()).toBe('charged');
  });

  it('다른 구독의 환불 진행은 영향을 주지 않는다', async () => {
    mockDb.payments.push(row('sub_other_202610_1', 'DONE', { member_plan_id: 'other' }));
    mockDb.cancels.push({ payment_id: 'seed-sub_other_202610_1', status: 'PENDING' });
    okConfirm();
    expect(await run()).toBe('charged');
  });
});

// N-6·N-10 (배치 쪽) — 승인 도중 플랜 변경 예약이 바뀌어도 이미 승인된 결제를 취소하지 않고 예약을 보존한다
describe('[N-6/N-10] 승인 도중 플랜 변경 예약이 바뀌어도 지급하고 새 예약은 보존한다', () => {
  beforeEach(() => {
    mockDb.masters.push({ plan_id: 'p2', plan_title: '프리미엄', actual_amount: 19900, credit: 30, is_del: 'N', is_active: 'Y', plan_type: 'SUBSCRIPTION' });
    mockDb.masters.push({ plan_id: 'p3', plan_title: '라이트', actual_amount: 5900, credit: 5, is_del: 'N', is_active: 'Y', plan_type: 'SUBSCRIPTION' });
  });

  it('예약 없이 청구 중 회원이 p2 로 변경 예약 → 이번 주기는 p1 으로 지급, 예약 p2 는 남는다 (취소하지 않음)', async () => {
    mockConfirm.mockImplementation(async (i: any) => {
      mockDb.plans[0].pending_plan_id = 'p2';
      return { transactionId: 'tx-1', orderId: i.orderId, amount: i.amount };
    });

    expect(await run()).toBe('charged');

    expect(mockCancel).not.toHaveBeenCalled();
    expect(dbPlan()).toMatchObject({ plan_id: 'p1', pending_plan_id: 'p2', status: 'ACTIVE', locked_amount: 9900 });
    expect(mockDb.payments[0].status).toBe('DONE');
  });

  it('p2 예약분을 청구 중 회원이 p3 로 바꿈 → p2 로 지급·전환하되 예약 p3 는 보존한다', async () => {
    Object.assign(dbPlan(), { pending_plan_id: 'p2' });
    mockConfirm.mockImplementation(async (i: any) => {
      mockDb.plans[0].pending_plan_id = 'p3';
      return { transactionId: 'tx-1', orderId: i.orderId, amount: i.amount };
    });

    expect(await run({ plan: { pending_plan_id: 'p2' } })).toBe('charged');

    expect(dbPlan()).toMatchObject({ plan_id: 'p2', pending_plan_id: 'p3', locked_amount: 19900 });
  });

  it('청구한 예약 그대로면 지급 후 예약을 지운다 (기존 동작)', async () => {
    Object.assign(dbPlan(), { pending_plan_id: 'p2' });
    okConfirm();
    expect(await run({ plan: { pending_plan_id: 'p2' } })).toBe('charged');
    expect(dbPlan()).toMatchObject({ plan_id: 'p2', pending_plan_id: null });
  });
});

// 07-subscription-review M-3 — 예약 플랜 검증을 백엔드(loadSubscribablePlan)와 맞춘다
describe('[M-3] 예약(pending_plan_id) 플랜 검증 — 판매 중인 구독 플랜이고 금액이 100원 이상일 때만 청구한다', () => {
  it.each([
    ['판매 중단(is_active=N)', { plan_type: 'SUBSCRIPTION', is_active: 'N', actual_amount: 19900 }],
    ['구독 플랜이 아님(CREDIT_PACK)', { plan_type: 'CREDIT_PACK', is_active: 'Y', actual_amount: 19900 }],
    ['금액 100원 미만', { plan_type: 'SUBSCRIPTION', is_active: 'Y', actual_amount: 99 }],
  ])('%s → 청구하지 않고 구독 상태·예약·결제일을 그대로 둔다(오류 로그)', async (_name, master) => {
    mockDb.masters.push({ plan_id: 'p2', plan_title: '예약 플랜', credit: 30, is_del: 'N', ...master });
    Object.assign(dbPlan(), { pending_plan_id: 'p2' });
    const before = JSON.stringify(mockDb.plans);

    const r = await run({ plan: { pending_plan_id: 'p2' } });

    expect(r).toBe('skipped');
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockDb.payments).toHaveLength(0);
    expect(JSON.stringify(mockDb.plans)).toBe(before);
    expect(log.error).toHaveBeenCalled();
  });

  it('예약이 없으면 현재 플랜은 판매 중단이어도 가입 시점 고정가로 계속 청구된다(이미 구독 중인 회원)', async () => {
    mockDb.masters[0].is_active = 'N';
    okConfirm();
    expect(await run()).toBe('charged');
  });
});

// ====================================================================
// 구독 해지 알림(카카오 알림톡 스텁) — 실제로 해지되는 모든 배치 경로에서 member_notification 에 기록한다.
// 알림은 해지 트랜잭션 안의 SAVEPOINT 로 기록하므로, 알림 insert 실패는 해지·결제를 깨뜨리지 않는다.
describe('[알림] 구독 해지 알림 기록', () => {
  const notice = (reason: string) => ({
    member_id: 'm1',
    category: 'KAKAO_STUB',
    link: `subscription/mp1?reason=${reason}`,
    is_read: 'N',
    is_del: 'N',
  });

  it('재시도 실패 해지(PAST_DUE → CANCELED)는 RETRY_FAILED 를 기록한다', async () => {
    mockConfirm.mockRejectedValue(new DanalApiError('CARD_LIMIT', '한도 초과'));
    await run({ onFail: 'PAST_DUE' });
    expect(mockDb.notifications).toHaveLength(0); // 1차 실패는 해지가 아니다
    setToday(2026, 11, 4);

    await run({ plan: { ...dbPlan() }, onFail: 'CANCELED' });

    expect(dbPlan().status).toBe('CANCELED');
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.notifications[0]).toMatchObject(notice('RETRY_FAILED'));
    expect(mockDb.notifications[0].title).toBe('결제 실패로 구독이 해지되었어요');
  });

  it('비활성 카드로 재시도 잡에서 해지돼도 RETRY_FAILED', async () => {
    mockDb.plans[0].status = 'PAST_DUE';
    await run({ plan: { status: 'PAST_DUE' }, billing: { is_active: 'N' }, onFail: 'CANCELED' });
    expect(dbPlan().status).toBe('CANCELED');
    expect(mockDb.notifications.map((n) => n.link)).toEqual(['subscription/mp1?reason=RETRY_FAILED']);
  });

  it('1차 실패(ACTIVE → PAST_DUE)·결과 불명·시스템 오류 취소는 해지가 아니므로 알림이 없다', async () => {
    mockConfirm.mockRejectedValueOnce(new DanalApiError('CARD_LIMIT', '한도 초과'));
    await run({ onFail: 'PAST_DUE' });
    mockConfirm.mockRejectedValueOnce(new DanalResultUnknownError('timeout'));
    mockDb.plans[0].status = 'PAST_DUE';
    mockDb.payments.length = 0;
    await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' });
    expect(mockDb.notifications).toHaveLength(0);
  });

  it('이전 PG 카드 해지는 OLD_PG_CARD, 카드 없음도 OLD_PG_CARD', async () => {
    expect(await run({ billing: { provider: 'INICIS' } })).toBe('canceled');
    expect(mockDb.notifications.map((n) => n.link)).toEqual(['subscription/mp1?reason=OLD_PG_CARD']);
    expect(mockDb.notifications[0]).toMatchObject(notice('OLD_PG_CARD'));

    mockDb.notifications = [];
    mockDb.plans[0] = { ...planRow() };
    expect(await run({ billing: null })).toBe('canceled');
    expect(mockDb.notifications.map((n) => n.link)).toEqual(['subscription/mp1?reason=OLD_PG_CARD']);
  });

  it('구독이 조회 이후 바뀌어 해지하지 못했으면(skipped) 알림도 없다', async () => {
    Object.assign(dbPlan(), { status: 'CANCELED', is_active: 'N', next_charge_dt: null });
    expect(await run({ billing: { provider: 'INICIS' } })).toBe('skipped');
    expect(mockDb.notifications).toHaveLength(0);
  });

  it('정지 회원 해지는 MEMBER_SUSPENDED', async () => {
    mockDb.suspensions.push({ member_id: 'm1', released_at: null, end_at: null });
    expect(await run()).toBe('canceled');
    expect(mockDb.notifications).toHaveLength(1);
    expect(mockDb.notifications[0]).toMatchObject(notice('MEMBER_SUSPENDED'));
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it('알림 insert 가 실패해도 해지는 그대로 완료된다(해지·결제 트랜잭션을 깨뜨리지 않는다)', async () => {
    mockDb.failNotificationInsert = true;
    expect(await run({ billing: { provider: 'INICIS' } })).toBe('canceled');
    expect(dbPlan()).toMatchObject({ status: 'CANCELED', is_active: 'N', next_charge_dt: null });
    expect(mockDb.notifications).toHaveLength(0);
    expect(JSON.stringify(log.error.mock.calls)).toContain('NOTIFY_FAILED');

    // 재시도 실패 해지도 마찬가지 — 거절 기록(ABORTED)과 해지가 유지된다
    mockDb.plans[0] = { ...planRow({ status: 'PAST_DUE' }) };
    mockConfirm.mockRejectedValue(new DanalApiError('CARD_LIMIT', '한도 초과'));
    expect(await run({ plan: { status: 'PAST_DUE' }, onFail: 'CANCELED' })).toBe('declined');
    expect(dbPlan().status).toBe('CANCELED');
    expect(mockDb.payments.at(-1)).toMatchObject({ status: 'ABORTED', fail_code: 'CARD_LIMIT' });
  });
});

// ====================================================================
// 실패 사유 — 배치가 처리 중 예기치 못한 예외를 만나면 CONFIRMING 행에 fail_code=BATCH_FAILED 를 남긴다
// (백엔드가 이 코드를 읽어 화면 상태 '재시도대기' · 사유 '배치 실패' 로 보여준다)
describe('[실패 사유] BATCH_FAILED', () => {
  /** transactionId 를 읽는 순간 던지는 승인 응답 — settle 본문의 try/catch 밖에서 터지는 예외를 흉내 낸다 */
  const explodingResponse = () => ({
    get transactionId(): string {
      throw new Error('unexpected failure');
    },
  });

  it('settle 밖으로 예외가 새면 CONFIRMING 은 유지하고 fail_code=BATCH_FAILED 를 기록한 뒤 예외를 던진다', async () => {
    mockConfirm.mockResolvedValue(explodingResponse());
    await expect(run()).rejects.toThrow('unexpected failure');
    expect(mockDb.payments).toHaveLength(1);
    expect(mockDb.payments[0]).toMatchObject({ order_id: `${K}_1`, status: 'CONFIRMING', fail_code: 'BATCH_FAILED' });
    expect(mockDb.payments[0].fail_reason).toContain('unexpected failure');
    expect(dbPlan().status).toBe('ACTIVE'); // 구독 상태는 바꾸지 않는다
  });

  it('이미 있는 fail_code 는 덮어쓰지 않는다 (fail_code IS NULL 조건)', async () => {
    mockConfirm.mockImplementation(async () => {
      mockDb.payments[0].fail_code = 'ADMIN_CANCEL_PENDING'; // 승인 도중 운영자가 취소를 시작
      return explodingResponse();
    });
    await expect(run()).rejects.toThrow('unexpected failure');
    expect(mockDb.payments[0].fail_code).toBe('ADMIN_CANCEL_PENDING');
  });

  it('BATCH_FAILED 기록이 실패해도 원래 예외를 가리지 않는다', async () => {
    mockConfirm.mockResolvedValue(explodingResponse());
    const realUpdate = mockDb.manager.update;
    jest.spyOn(mockDb.manager, 'update').mockImplementation((async (E: any, criteria: Row, patch: Row) => {
      if (patch?.fail_code === 'BATCH_FAILED') throw new Error('db down');
      return realUpdate(E, criteria, patch);
    }) as any);
    await expect(run()).rejects.toThrow('unexpected failure');
    expect(mockDb.payments[0]).toMatchObject({ status: 'CONFIRMING', fail_code: null });
  });

  it('정상 경로(거절·결과 불명)는 BATCH_FAILED 로 덮어쓰지 않는다', async () => {
    mockConfirm.mockRejectedValue(new DanalResultUnknownError('timeout'));
    await run();
    expect(mockDb.payments[0].fail_code).toBe('CONFIRM_UNKNOWN');
  });
});
