import { EntityManager } from 'typeorm';
import { AppDataSource } from '../db/data-source';
import { config } from '../config';
import { MemberPlan } from '../entities/member-plan.entity';
import { MemberBilling } from '../entities/member-billing.entity';
import { Plan } from '../entities/plan.entity';
import { Payment } from '../entities/payment.entity';
import { MemberCredit } from '../entities/member-credit.entity';
import { MemberCreditLog } from '../entities/member-credit-log.entity';
import { ActiveStatus, IsYn, PaymentStatus, PlanStatus } from '../entities/enums';
import { cancel, confirmBilling, DanalApiError } from '../utils/danal-billing.client';
import { decryptBillingKey, isEncryptedBillingKey } from '../utils/billing-crypto.util';
import {
  attemptOrderId,
  classifyCycle,
  cycleKey,
  cycleLikePattern,
  isCyclePeriodEnded,
  nextChargeDateAfter,
} from '../utils/subscription-cycle.util';
import { addMonthsClamped, toLocalDate, today, ymd } from '../utils/date.util';
import { createJobLogger } from '../logger';

/**
 * 다날 구독 월 자동결제 — 백엔드 SubscriptionChargeService.chargeRecurring + SubscriptionSettleService 와 같은 순서·같은 동작표(T1~T13).
 *
 *   사전 검증 → 선점 트랜잭션(락, 주기 판정, payment CONFIRMING 삽입) → (트랜잭션 밖) 다날 승인
 *   → 응답 대조 → 지급 트랜잭션 → 실패 시 보상 취소
 *
 * 규칙: 다날 호출 전에 반드시 CONFIRMING 으로 선점한다. 결과 불명은 같은 orderId 로 재호출하지 않는다.
 * 빌링키 평문·비밀키는 로그·예외 메시지에 남기지 않는다.
 */

type Log = ReturnType<typeof createJobLogger>;

export type ChargeOutcome = 'charged' | 'skipped' | 'failed' | 'unknown';
export type OnFailStatus = typeof PlanStatus.PAST_DUE | typeof PlanStatus.SUSPENDED;

const BILLING_PROVIDER_DANAL = 'DANAL';
/** 예약(pending_plan_id) 플랜으로 청구할 수 있는 플랜 종류 — 백엔드 loadSubscribablePlan 과 같다 */
const SUBSCRIPTION_PLAN_TYPE = 'SUBSCRIPTION';
/** 다날 카드 최소 결제 금액(원) */
const MIN_CARD_AMOUNT = 100;
/** 크레딧 유효기간(개월) — 결제일로부터 3개월 */
const CREDIT_VALID_MONTHS = 3;
const FAIL_REASON_MAX_LENGTH = 500;
/** 운영자가 다날 취소를 진행 중이거나 결과를 모르는 건 — 지급을 거절한다 */
const GRANT_BLOCKING_FAIL_CODES: readonly string[] = ['ADMIN_CANCEL_PENDING', 'ADMIN_CANCEL_UNKNOWN'];
/** 취소에 성공한 시스템 오류 건 — 같은 주기에 있으면 매일 승인-취소를 반복하지 않도록 건너뛴다(결정 4) */
const SYSTEM_CANCELED_FAIL_CODES: readonly string[] = ['CONFIRM_MISMATCH_CANCELED', 'GRANT_FAILED_CANCELED'];

/** 지급 트랜잭션에서 결제가 CONFIRMING 이 아니었다 (status=null 이면 결제 없음) */
class PaymentStateError extends Error {
  constructor(readonly status: string | null) {
    super(`예상하지 못한 결제 상태: ${status ?? 'NONE'}`);
  }
}

/** 지급 트랜잭션에서 구독이 청구 시점과 달라졌다(해지·삭제·카드 교체 등) — 지급하지 않고 보상 취소한다 */
class SubscriptionStateError extends Error {
  constructor(readonly reason: string) {
    super(`승인 후 구독 상태 변경: ${reason}`);
  }
}

/** PostgreSQL unique 위반(23505). TypeORM QueryFailedError 는 driverError 에, 드라이버 오류는 자신에게 code 가 있다. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } } | null;
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

/** classifyCycle 이 같은 주기로 보는 order_id: `{key}` 또는 `{key}_{숫자}` (다른 접두 유사 행·`_fail_` 행 제외) */
function isCycleOrderId(orderId: string | null, key: string): boolean {
  if (!orderId) return false;
  if (orderId === key) return true;
  if (!orderId.startsWith(`${key}_`)) return false;
  return /^\d+$/.test(orderId.slice(key.length + 1));
}

/** date 컬럼 값(런타임에는 'YYYY-MM-DD' 문자열, 혹은 Date) → 'YYYY-MM-DD' (UTC 변환 없이) */
function toYmdString(v: Date | string): string {
  return typeof v === 'string' ? v.slice(0, 10) : ymd(v);
}

const sameValue = (a: unknown, b: unknown): boolean => (a ?? null) === (b ?? null);
const sameNumeric = (a: unknown, b: unknown): boolean => String(a ?? '') === String(b ?? '');

/**
 * 잡이 구독을 조회한 뒤 DB 가 바뀌었는지 본다. 바뀐 이유를 돌려주고, 그대로면 null.
 * 해지·삭제·비활성·결제일 전진·카드 교체·플랜 예약 변경·가격 고정값 변경 어느 것이든 스냅샷으로 청구하지 않는다.
 */
function staleReason(snapshot: MemberPlan, fresh: MemberPlan | null): string | null {
  if (!fresh) return '구독 행 없음';
  if (fresh.is_del !== IsYn.N) return '구독 삭제됨';
  if (fresh.is_active !== ActiveStatus.Y) return '구독 비활성';
  if (!sameValue(fresh.status, snapshot.status)) return `구독 상태 변경(${fresh.status ?? 'NULL'})`;
  if (!fresh.next_charge_dt || !snapshot.next_charge_dt) return '결제일 없음';
  if (toYmdString(fresh.next_charge_dt) !== toYmdString(snapshot.next_charge_dt)) return '결제일 변경';
  if (!sameValue(fresh.member_billing_id, snapshot.member_billing_id)) return '결제 카드 변경';
  if (!sameValue(fresh.plan_id, snapshot.plan_id)) return '플랜 변경';
  if (!sameValue(fresh.pending_plan_id, snapshot.pending_plan_id)) return '플랜 변경 예약 변경';
  if (!sameNumeric(fresh.locked_amount, snapshot.locked_amount) || !sameNumeric(fresh.locked_credit, snapshot.locked_credit)) {
    return '고정 가격 변경';
  }
  return null;
}

/**
 * 멱등 케이스(T1): 이미 결제된 주기 → 청구 없이 결제일만 다음 주기로 갱신한다(백엔드 재청구 T1 과 같은 동작).
 * - 결제된 회원이므로 ACTIVE 로 둔다(PAST_DUE 에 남기면 다음 재시도 잡이 결제일 전에 청구하려 든다).
 * - 어느 플랜으로 결제됐는지 알 수 없으므로 plan_id·pending_plan_id·고정가는 건드리지 않는다.
 * - 다음 결제일은 오늘 이후로 맞춘다(밀린 결제일이 과거에 남아 연속 청구되지 않게) [C-1].
 */
async function advancePlanOnly(plan: MemberPlan, cycleYmd: string, manager: EntityManager): Promise<void> {
  const next = nextChargeDateAfter(cycleYmd, today());
  await manager.update(
    MemberPlan,
    { member_plan_id: plan.member_plan_id },
    { status: PlanStatus.ACTIVE, next_charge_dt: next, end_dt: next, updated_at: new Date() },
  );
}

/**
 * 밀린 주기(이용기간이 이미 끝난 주기) 처리 [C-1] — 청구하지 않고 다음 결제일만 오늘 이후로 옮긴다.
 * 이용기간(end_dt)은 연장하지 않는다. PAST_DUE 였다면 ACTIVE 로 돌려 새 결제일부터 정상 청구한다(실패 행·SUSPENDED 없음).
 */
async function reanchorPlan(plan: MemberPlan, cycleYmd: string, manager: EntityManager): Promise<Date> {
  const next = nextChargeDateAfter(cycleYmd, today());
  await manager.update(
    MemberPlan,
    { member_plan_id: plan.member_plan_id },
    { status: PlanStatus.ACTIVE, next_charge_dt: next, updated_at: new Date() },
  );
  return next;
}

/** 카드가 거절된 실패(T5)의 구독 상태 전이: PAST_DUE(1차) / SUSPENDED(재시도 — 비활성·해지 시각 기록) */
function failPatch(onFailStatus: OnFailStatus, now: Date): Partial<MemberPlan> {
  const patch: Partial<MemberPlan> = { status: onFailStatus, updated_at: now };
  if (onFailStatus === PlanStatus.SUSPENDED) {
    patch.is_active = ActiveStatus.N;
    patch.canceled_at = now;
  }
  return patch;
}

/**
 * 저장된 빌링키를 평문으로 복원한다. 청구할 수 없는 상태면 null(상태 불변, 오류 로그).
 * - enc:v1: 형식이 아니면(임시값·레거시 평문 포함) 청구하지 않는다.
 * - 암호문인데 BILLING_KEY_ENC_KEY 가 없으면 청구하지 않는다.
 */
function resolveBillingKey(plan: MemberPlan, billing: MemberBilling, log: Log): string | null {
  const stored = billing.billing_key ?? '';
  if (!isEncryptedBillingKey(stored)) {
    log.error(`[CRITICAL] 빌링키가 암호화 형식이 아니라 청구하지 않음 plan=${plan.member_plan_id} member_billing=${billing.member_billing_id}`);
    return null;
  }
  if (!config.billing.encKey) {
    log.error(`[CRITICAL] BILLING_KEY_ENC_KEY 가 설정되지 않아 빌링키를 복호화할 수 없음 plan=${plan.member_plan_id}`);
    return null;
  }
  try {
    const plain = decryptBillingKey(stored, config.billing.encKey);
    if (!plain) throw new Error('empty');
    return plain;
  } catch {
    // 복호화 오류 메시지에는 암호문 조각이 섞일 수 있어 원문을 남기지 않는다
    log.error(`[CRITICAL] 빌링키 복호화 실패 plan=${plan.member_plan_id} member_billing=${billing.member_billing_id}`);
    return null;
  }
}

type Claim =
  | { kind: 'already' }
  | { kind: 'reanchored'; next: string }
  | { kind: 'confirming' }
  | { kind: 'exhausted' }
  | { kind: 'stale'; reason: string }
  | { kind: 'withdrawn' }
  | { kind: 'blocked'; failCode: string }
  | { kind: 'claimed'; paymentId: string; orderId: string };

/**
 * 다날 카드 구독 1건을 청구한다.
 * - 'charged'  : 승인·지급 완료 (T4)
 * - 'skipped'  : 청구하지 않음 (T1 결제일만 전진·T2·T3·T11, 사전 검증 불가, 결정 4)
 * - 'failed'   : 확실한 실패 (T5 카드 거절 → 구독 상태 전이 / T8·T9 취소 성공 → 상태 불변)
 * - 'unknown'  : 결과 불명 (T6·T7·T10, 취소 실패) — CONFIRMING 으로 남겨 어드민이 해소한다
 */
export async function chargeDanalPlan(
  plan: MemberPlan,
  billing: MemberBilling,
  onFailStatus: OnFailStatus,
  log: Log,
): Promise<ChargeOutcome> {
  const planId = plan.member_plan_id;

  // ===== 사전 검증 (DB 를 바꾸기 전에 끝낸다) =====
  if (!plan.next_charge_dt) {
    log.warn(`next_charge_dt 없음 — 결제 스킵 plan=${planId}`);
    return 'skipped';
  }
  // 결제일이 아직 오지 않은 구독은 청구하지 않는다(재시도 잡이 PAST_DUE 를 미리 청구하던 문제) [M-2]
  if (toLocalDate(plan.next_charge_dt).getTime() > today().getTime()) {
    log.warn(`결제일이 아직 오지 않아 청구하지 않음 plan=${planId} next_charge_dt=${toYmdString(plan.next_charge_dt)}`);
    return 'skipped';
  }
  // [T11] 다날 카드가 아니면 청구하지 않는다 — 재등록 후 카드 교체가 필요하다
  if ((billing.provider ?? '').toUpperCase() !== BILLING_PROVIDER_DANAL) {
    log.warn(`다날 카드가 아니라 청구하지 않음(재등록 필요) plan=${planId}`);
    return 'skipped';
  }
  // 사용할 수 없는 카드 — 청구를 시도한 적이 없으므로 결제 행 없이 구독 상태만 전이한다
  if (billing.is_active !== ActiveStatus.Y) {
    log.warn(`결제 카드가 비활성이라 결제 불가 plan=${planId} → ${onFailStatus}`);
    await AppDataSource.manager.update(MemberPlan, { member_plan_id: planId }, failPatch(onFailStatus, new Date()));
    return 'failed';
  }
  if (!config.danal.secretKey || !config.danal.merchantId) {
    log.error(`[CRITICAL] DANAL_SECRET_KEY / DANAL_MERCHANT_ID 가 설정되지 않아 청구하지 않음 plan=${planId}`);
    return 'skipped';
  }
  const plain = resolveBillingKey(plan, billing, log);
  if (!plain) return 'skipped';

  // pending_plan_id(플랜 변경 예약)가 있으면 이번 결제부터 신규 플랜 적용
  const effectivePlanId = plan.pending_plan_id ?? plan.plan_id;
  const master = await AppDataSource.manager.findOne(Plan, { where: { plan_id: effectivePlanId, is_del: IsYn.N } });
  if (!master) {
    log.error(`[CRITICAL] 구독 플랜을 찾을 수 없어 청구하지 않음 plan=${planId} plan_id=${effectivePlanId}`);
    return 'skipped';
  }
  // [M-3] 예약 플랜은 판매 중인 구독 플랜이어야 한다(백엔드 loadSubscribablePlan 과 같다). 아니면 청구하지 않고 상태를 그대로 둔다.
  if (plan.pending_plan_id && (master.is_active !== ActiveStatus.Y || master.plan_type !== SUBSCRIPTION_PLAN_TYPE)) {
    log.error(
      `[CRITICAL] 예약 플랜이 판매 중인 구독 플랜이 아니라 청구하지 않음 plan=${planId} pending_plan_id=${plan.pending_plan_id} is_active=${master.is_active} plan_type=${master.plan_type}`,
    );
    return 'skipped';
  }
  // 금액은 DB 값만 쓴다: 예약이 있으면 새 플랜 값, 없으면 가입 시점 고정값(없으면 현재가)
  const amount = plan.pending_plan_id ? master.actual_amount : (plan.locked_amount ?? master.actual_amount);
  const credit = plan.pending_plan_id ? (master.credit ?? 0) : (plan.locked_credit ?? master.credit ?? 0);
  if (amount == null || amount < MIN_CARD_AMOUNT) {
    log.error(`청구 금액이 ${MIN_CARD_AMOUNT}원 미만이라 청구하지 않음 plan=${planId} amount=${amount}`);
    return 'skipped';
  }
  const orderName = master.plan_title ?? '구독 결제';

  const cycleYmd = toYmdString(plan.next_charge_dt);
  const key = cycleKey(planId, cycleYmd);

  // ===== 선점 트랜잭션: 같은 주기 판정 + CONFIRMING 삽입 (다날 호출 전) =====
  let claim: Claim;
  try {
    claim = await AppDataSource.transaction(async (m): Promise<Claim> => {
      // 백엔드 chargeRecurring 과 같은 락 문자열 — 백엔드 재청구와 배치가 같은 주기에서 직렬화된다 [T12]
      await m.query(`SELECT pg_advisory_xact_lock(hashtext('subcycle:' || $1))`, [key]);

      // [H-1] 잡 시작 때 읽은 스냅샷을 믿지 않는다 — 구독 행을 잠그고 지금 상태를 다시 확인한다(해지·카드 교체·결제일 전진 등)
      const fresh = await m.findOne(MemberPlan, { where: { member_plan_id: planId }, lock: { mode: 'pessimistic_write' } });
      const stale = staleReason(plan, fresh);
      if (stale) return { kind: 'stale', reason: stale };
      // [H-3] 탈퇴한 회원의 카드는 청구하지 않는다(회원 행이 없어도 fail-closed)
      const memberRows: { is_del: string | null }[] = await m.query(`SELECT is_del FROM member WHERE member_id = $1`, [plan.member_id]);
      if (memberRows[0]?.is_del !== IsYn.N) return { kind: 'withdrawn' };

      const rows: { payment_id: string; order_id: string | null; status: string | null; fail_code: string | null }[] =
        await m.query(
          `SELECT payment_id, order_id, status, fail_code FROM payment WHERE order_id = $1 OR order_id LIKE $2 ESCAPE '\\'`,
          [key, cycleLikePattern(key)],
        );
      const cycle = classifyCycle(rows, key);
      if (cycle.done) {
        // [T1] 이미 결제된 주기 — 청구 없이 결제일만 전진
        await advancePlanOnly(plan, cycleYmd, m);
        return { kind: 'already' };
      }
      if (cycle.confirming) return { kind: 'confirming' }; // [T2] (결과 불명 건은 재설정하지 않는다 — 어드민 GRANT 해소가 주기 키를 맞춘다)
      // [C-1] 이용기간이 끝난 지난 주기는 청구하지 않는다 — 다음 결제일만 오늘 이후로 옮기고 그 주기부터 청구한다
      if (isCyclePeriodEnded(cycleYmd, today())) {
        const next = await reanchorPlan(plan, cycleYmd, m);
        return { kind: 'reanchored', next: ymd(next) };
      }
      if (cycle.nextAttempt === null) return { kind: 'exhausted' }; // [T3]
      const blockedRow = rows.find(
        (r) =>
          r.status === PaymentStatus.ABORTED &&
          !!r.fail_code &&
          SYSTEM_CANCELED_FAIL_CODES.includes(r.fail_code) &&
          isCycleOrderId(r.order_id, key),
      );
      if (blockedRow) return { kind: 'blocked', failCode: blockedRow.fail_code! };

      const orderId = attemptOrderId(key, cycle.nextAttempt); // [T13]
      const now = new Date();
      const payment = await m.save(
        m.create(Payment, {
          member_id: plan.member_id,
          payment_type: 'CREDIT',
          purchase_type: 'SUBSCRIPTION',
          plan_id: effectivePlanId,
          member_plan_id: planId,
          grant_credit: credit,
          amount,
          currency: 'KRW',
          status: PaymentStatus.CONFIRMING,
          fail_code: null,
          order_id: orderId,
          order_name: orderName,
          pg_provider: 'danal',
          requested_at: now,
          updated_at: now,
        }),
      );
      return { kind: 'claimed', paymentId: payment.payment_id, orderId };
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      log.warn(`같은 주기에 처리 중인 결제가 있어 건너뜀 plan=${planId} key=${key}`);
      return 'skipped';
    }
    throw err; // 선점 실패 — 다날을 호출하지 않았다
  }

  switch (claim.kind) {
    case 'already':
      log.info(`이미 결제됨(멱등) key=${key} → 결제일만 갱신`);
      return 'skipped';
    case 'reanchored':
      log.warn(`결제일이 밀려 지난 주기는 청구하지 않고 다음 결제일을 ${claim.next} 로 재설정함 plan=${planId} key=${key}`);
      return 'skipped';
    case 'confirming':
      log.warn(`이 주기에 결과 확인 중인 결제가 있어 건너뜀 key=${key}`);
      return 'skipped';
    case 'stale':
      log.warn(`구독이 조회 이후 바뀌어 청구하지 않음(${claim.reason}) plan=${planId} key=${key}`);
      return 'skipped';
    case 'withdrawn':
      log.warn(`탈퇴한 회원이라 청구하지 않음 plan=${planId} key=${key}`);
      return 'skipped';
    case 'exhausted':
      log.error(`[CRITICAL] 청구 시도 번호 초과 — 결제 이력 확인 필요 plan=${planId} key=${key}`);
      return 'skipped';
    case 'blocked':
      log.error(
        `[CRITICAL] 같은 주기에 시스템 오류로 취소된 시도(${claim.failCode})가 있어 청구하지 않음 — 원인 확인 후 어드민 재청구 plan=${planId} key=${key}`,
      );
      return 'skipped';
  }

  return settle(
    {
      paymentId: claim.paymentId,
      orderId: claim.orderId,
      plan,
      amount,
      credit,
      plain,
      orderName,
      chargePlanId: effectivePlanId,
      cycleYmd,
      onFailStatus,
    },
    log,
  );
}

interface SettleCtx {
  paymentId: string;
  orderId: string;
  plan: MemberPlan;
  amount: number;
  credit: number;
  /** 복호화된 빌링키 — 로그·예외에 남기지 않는다 */
  plain: string;
  orderName: string;
  chargePlanId: string;
  cycleYmd: string;
  onFailStatus: OnFailStatus;
}

/** 다날 승인 이후 처리: 응답 대조 → 지급 트랜잭션 → 실패 시 보상 취소. 다날 호출은 트랜잭션 밖에서만 한다. */
async function settle(ctx: SettleCtx, log: Log): Promise<ChargeOutcome> {
  const planId = ctx.plan.member_plan_id;

  let res: Awaited<ReturnType<typeof confirmBilling>>;
  try {
    res = await confirmBilling({
      billingKey: ctx.plain,
      userId: ctx.plan.member_id,
      amount: ctx.amount,
      orderName: ctx.orderName,
      orderId: ctx.orderId,
    });
  } catch (err) {
    if (err instanceof DanalApiError) {
      // [T5] 다날이 code 로 거절 — 확실한 실패. 선점 행을 ABORTED 로 닫고 구독 상태를 전이한다(별도 _fail_ 행 없음)
      log.warn(`결제 실패 plan=${planId} [${err.code}] ${err.message} → ${ctx.onFailStatus}`);
      try {
        await AppDataSource.transaction(async (m) => {
          const now = new Date();
          await m.update(
            Payment,
            { payment_id: ctx.paymentId, status: PaymentStatus.CONFIRMING },
            { status: PaymentStatus.ABORTED, fail_code: err.code, fail_reason: err.message.slice(0, FAIL_REASON_MAX_LENGTH), updated_at: now },
          );
          await m.update(MemberPlan, { member_plan_id: planId }, failPatch(ctx.onFailStatus, now));
        });
      } catch (dbErr) {
        log.error(`[CRITICAL] 거절 결과 기록 실패 — 수동 정합 필요 order=${ctx.orderId}: ${(dbErr as Error).message}`);
      }
      return 'failed';
    }
    // [T6] 결과 불명 — 재시도하지 않는다. 구독 상태도 바꾸지 않는다
    log.error(`[CONFIRM_UNKNOWN] 다날 빌링 승인 결과 불명 order=${ctx.orderId}: ${(err as Error).message}`);
    await record(ctx.paymentId, { fail_code: 'CONFIRM_UNKNOWN', fail_reason: (err as Error).message }, log);
    return 'unknown';
  }

  const tid = res.transactionId;
  if (!tid) {
    // [T7]
    log.error(`[CRITICAL] 승인 성공인데 거래 ID 없음 — 수동 확인 필요 order=${ctx.orderId}`);
    await record(
      ctx.paymentId,
      { fail_code: 'CONFIRM_NO_TRANSACTION_ID', fail_reason: '승인 응답에 거래 ID가 없습니다.' },
      log,
    );
    return 'unknown';
  }

  // 응답 대조 — 필드가 없으면 불일치로 본다(fail-closed)
  if (res.orderId !== ctx.orderId || res.amount === null || Number(res.amount) !== ctx.amount) {
    // [T8]
    log.error(
      `[CRITICAL] 승인 응답 대조 불일치 order=${ctx.orderId} tx=${tid} responseOrder=${res.orderId} responseAmount=${res.amount}`,
    );
    try {
      await cancel({ transactionId: tid, amount: ctx.amount, cancelType: 'C', cancelReason: '승인 응답 불일치 자동취소' });
    } catch (err) {
      log.error(`[CRITICAL] 불일치 보상 취소 실패 — 수동 취소 필요 order=${ctx.orderId} tx=${tid}: ${(err as Error).message}`);
      await record(
        ctx.paymentId,
        { fail_code: 'CONFIRM_MISMATCH_CANCEL_FAILED', fail_reason: '승인 응답 불일치 후 보상 취소 실패', pg_transaction_id: tid },
        log,
      );
      return 'unknown';
    }
    await record(
      ctx.paymentId,
      { status: PaymentStatus.ABORTED, fail_code: 'CONFIRM_MISMATCH_CANCELED', fail_reason: '승인 응답 불일치로 자동 취소' },
      log,
    );
    return 'failed'; // 카드 문제가 아니라 시스템 문제 — 구독 상태는 바꾸지 않는다
  }

  try {
    await AppDataSource.transaction(async (m) => {
      const locked = await m.findOne(Payment, { where: { payment_id: ctx.paymentId }, lock: { mode: 'pessimistic_write' } });
      if (locked?.status !== PaymentStatus.CONFIRMING) throw new PaymentStateError(locked?.status ?? null);
      if (locked.fail_code && GRANT_BLOCKING_FAIL_CODES.includes(locked.fail_code)) {
        throw new PaymentStateError(`${PaymentStatus.CONFIRMING}:${locked.fail_code}`);
      }
      // [H-1] 승인 동안 구독이 바뀌었으면(해지·삭제 등) 지급·되살리기 없이 보상 취소로 간다
      const freshPlan = await m.findOne(MemberPlan, {
        where: { member_plan_id: ctx.plan.member_plan_id },
        lock: { mode: 'pessimistic_write' },
      });
      const stale = staleReason(ctx.plan, freshPlan);
      if (stale) throw new SubscriptionStateError(stale);
      await applyGrant(m, locked, tid, ctx);
    });
  } catch (err) {
    return compensateGrantFailure(ctx, tid, err as Error, log);
  }
  log.info(`결제 성공 plan=${planId} amount=${ctx.amount} credit=+${ctx.credit}`);
  return 'charged';
}

/** 지급 트랜잭션 실패 보상 — 백엔드 SubscriptionSettleService.compensateGrantFailure 와 같은 순서 */
async function compensateGrantFailure(
  ctx: SettleCtx,
  tid: string,
  cause: Error,
  log: Log,
): Promise<ChargeOutcome> {
  let current: Payment | null;
  try {
    current = await AppDataSource.manager.findOne(Payment, { where: { payment_id: ctx.paymentId } });
  } catch (err) {
    // [T9] 재조회 실패 — 지급 여부를 모르므로 취소하지 않는다
    log.error(
      `[CRITICAL] 보상 취소 전 결제 상태 재확인 실패 — 취소하지 않음 order=${ctx.orderId} tx=${tid} cause=${cause.message} readError=${(err as Error).message}`,
    );
    // [M-5] 승인된 거래 ID 를 남긴다 — 남기지 않으면 fail_code 없는 CONFIRMING 이라 "진행 중"과 구분되지 않는다
    await record(
      ctx.paymentId,
      { fail_code: 'GRANT_FAILED_UNVERIFIED', fail_reason: `지급 결과 재확인 실패: ${cause.message}`, pg_transaction_id: tid },
      log,
    );
    return 'unknown';
  }
  if (current?.status === PaymentStatus.DONE) {
    log.error(`[CRITICAL] 지급은 커밋됐으나 오류가 발생 — 보상 취소하지 않음 order=${ctx.orderId} tx=${tid} cause=${cause.message}`);
    return 'charged';
  }
  if (isUniqueViolation(cause)) {
    // [T10] 중복된 거래 ID 는 다른 결제의 거래다 — 취소하면 엉뚱한 거래가 취소된다
    log.error(`[CRITICAL] 거래 ID 중복 — 취소하지 않음, 수동 확인 필요 order=${ctx.orderId} tx=${tid}`);
    await record(
      ctx.paymentId,
      { fail_code: 'DUPLICATE_TRANSACTION_ID', fail_reason: '승인 거래 ID가 다른 결제와 중복됩니다.' },
      log,
    );
    return 'unknown';
  }
  if (cause instanceof PaymentStateError) {
    log.error(`[CRITICAL] 승인 후 결제 상태 변경 감지 — 지급·취소하지 않음 order=${ctx.orderId} tx=${tid} status=${cause.status}`);
    // 운영자가 건 취소 표식(CONFIRMING:ADMIN_CANCEL_*)은 덮어쓰지 않는다 — 덮으면 지급 차단이 풀린다
    if (!cause.status?.startsWith(`${PaymentStatus.CONFIRMING}:`)) {
      await record(
        ctx.paymentId,
        { fail_code: 'PAYMENT_STATE_CHANGED', fail_reason: `승인 후 결제 상태 변경: ${cause.status ?? 'NONE'}`, pg_transaction_id: tid },
        log,
      );
    }
    return 'unknown';
  }

  try {
    await cancel({ transactionId: tid, amount: ctx.amount, cancelType: 'C', cancelReason: '구독 지급 실패 자동취소' });
  } catch (err) {
    log.error(
      `[CRITICAL] 승인 후 지급 실패 + 보상 취소 실패 — 수동 환불 필요 order=${ctx.orderId} tx=${tid} cause=${cause.message} cancelError=${(err as Error).message}`,
    );
    await record(
      ctx.paymentId,
      { fail_code: 'GRANT_FAILED_CANCEL_FAILED', fail_reason: `지급 실패 후 보상 취소 실패: ${cause.message}`, pg_transaction_id: tid },
      log,
    );
    return 'unknown';
  }
  log.warn(`승인 후 지급 실패 → 보상 취소 완료 order=${ctx.orderId} tx=${tid} cause=${cause.message}`);
  await record(
    ctx.paymentId,
    { status: PaymentStatus.ABORTED, fail_code: 'GRANT_FAILED_CANCELED', fail_reason: `지급 실패로 자동 취소: ${cause.message}` },
    log,
  );
  return 'failed'; // 취소 성공 — 시스템 문제이므로 구독 상태는 바꾸지 않는다
}

/** payment → DONE, 크레딧 lot·로그, member_plan 갱신 — 지급 트랜잭션 본문 (백엔드 applyGrant 의 RECURRING 분기와 같다) */
async function applyGrant(m: EntityManager, payment: Payment, tid: string, ctx: SettleCtx): Promise<void> {
  const now = new Date();
  await m.update(
    Payment,
    { payment_id: payment.payment_id },
    {
      status: PaymentStatus.DONE,
      payment_key: tid,
      pg_transaction_id: tid,
      method: 'CARD',
      paid_at: now,
      updated_at: now,
    },
  );

  if (ctx.credit > 0) {
    const start = today();
    const lot = await m.save(
      m.create(MemberCredit, {
        member_id: payment.member_id,
        credit_type: 'SUBSCRIPTION',
        init_credit: ctx.credit,
        credit: ctx.credit,
        membership_title: payment.order_name,
        member_membership_id: ctx.plan.member_plan_id,
        source_payment_id: payment.payment_id,
        start_dt: start,
        end_dt: addMonthsClamped(start, CREDIT_VALID_MONTHS),
        is_del: IsYn.N,
        created_at: now,
        updated_at: now,
      }),
    );
    const total = await sumValidCredit(m, payment.member_id!);
    await m.save(
      m.create(MemberCreditLog, {
        member_credit_id: lot.member_credit_id,
        credit_action: ctx.credit,
        credit_type: 'SUBSCRIPTION',
        log_title: '구독 결제 크레딧 적립',
        log_desc: payment.order_name,
        total_credit: total,
        credit: ctx.credit,
        member_id: payment.member_id,
        is_member_view: IsYn.Y,
        is_partner_view: IsYn.N,
        created_at: now,
      }),
    );
  }

  // 오늘 이후로 맞춘다 — 정상 주기는 cycle+1개월 그대로이고, 해소(GRANT) 등으로 밀린 주기를 지급하는 경우에도 과거 결제일이 남지 않는다 [C-1]
  const next = nextChargeDateAfter(ctx.cycleYmd, today());
  const updated = await m.update(
    MemberPlan,
    { member_plan_id: ctx.plan.member_plan_id, is_del: IsYn.N },
    {
      plan_id: ctx.chargePlanId,
      pending_plan_id: null,
      status: PlanStatus.ACTIVE,
      is_active: ActiveStatus.Y,
      last_payment_id: payment.payment_id,
      next_charge_dt: next,
      end_dt: next, // 결제 성공 시 이용기간(end_dt)도 다음 주기까지 연장
      locked_amount: payment.amount,
      locked_credit: ctx.credit,
      updated_at: now,
    },
  );
  if (!updated.affected) throw new SubscriptionStateError('구독 갱신 0행'); // 롤백 후 보상 취소
}

async function sumValidCredit(m: EntityManager, memberId: string): Promise<number> {
  const rows: { sum: string | number | null }[] = await m.query(
    `SELECT COALESCE(SUM(credit), 0) AS sum FROM member_credit
      WHERE member_id = $1 AND is_del = 'N' AND start_dt <= CURRENT_DATE AND end_dt >= CURRENT_DATE`,
    [memberId],
  );
  return Number(rows[0]?.sum ?? 0);
}

/** CONFIRMING 결제에 결과를 기록한다. 승인 이후 경로라 기록 실패가 처리를 막지 않게 한다. */
async function record(
  paymentId: string,
  patch: { status?: string; fail_code: string; fail_reason: string; pg_transaction_id?: string },
  log: Log,
): Promise<void> {
  try {
    await AppDataSource.manager.update(
      Payment,
      { payment_id: paymentId, status: PaymentStatus.CONFIRMING },
      { ...patch, fail_reason: patch.fail_reason.slice(0, FAIL_REASON_MAX_LENGTH), updated_at: new Date() },
    );
  } catch (err) {
    if (patch.pg_transaction_id && isUniqueViolation(err)) {
      // 거래 ID 가 다른 결제와 중복이면 ID 없이 코드만 기록한다
      const { pg_transaction_id: _omit, ...rest } = patch;
      await record(paymentId, rest, log).catch(() => undefined);
      return;
    }
    log.error(`[CRITICAL] 결제 결과 기록 실패 — 수동 정합 필요 payment=${paymentId} fail_code=${patch.fail_code}: ${(err as Error).message}`);
  }
}
