import { EntityManager, IsNull, LessThanOrEqual } from 'typeorm';
import { AppDataSource } from '../db/data-source';
import { MemberPlan } from '../entities/member-plan.entity';
import { MemberBilling } from '../entities/member-billing.entity';
import { Plan } from '../entities/plan.entity';
import { Payment } from '../entities/payment.entity';
import { MemberCredit } from '../entities/member-credit.entity';
import { MemberCreditLog } from '../entities/member-credit-log.entity';
import { ActiveStatus, IsYn, PaymentStatus, PlanStatus } from '../entities/enums';
import { chargeBilling } from '../utils/toss-billing.client';
import { addMonthsClamped, today, ymd } from '../utils/date.util';
import { createJobLogger } from '../logger';

export const PRIMARY_JOB_NAME = 'subscription-billing';
export const RETRY_JOB_NAME = 'subscription-billing-retry';

/** 크레딧 유효기간(개월) — 구독 1회 결제로 적립되는 크레딧 */
const CREDIT_VALID_MONTHS = 1;

type Log = ReturnType<typeof createJobLogger>;

/** 매일 21:00 — ACTIVE 구독 중 결제일 도래분 청구 */
export async function executePrimary(log: Log): Promise<void> {
  const repo = AppDataSource.getRepository(MemberPlan);
  const due = await repo.find({
    where: [
      { is_del: IsYn.N, is_active: ActiveStatus.Y, status: PlanStatus.ACTIVE, next_charge_dt: LessThanOrEqual(today()) },
      { is_del: IsYn.N, is_active: ActiveStatus.Y, status: IsNull(), next_charge_dt: LessThanOrEqual(today()) },
    ],
  });
  log.info(`결제 대상 구독: ${due.length}건`);
  await processPlans(due, PlanStatus.PAST_DUE, log);
}

/** 매일 20:00 — 전일 실패(PAST_DUE) 구독 재시도, 실패 시 즉시 정지 */
export async function executeRetry(log: Log): Promise<void> {
  const repo = AppDataSource.getRepository(MemberPlan);
  const pastDue = await repo.find({
    where: { is_del: IsYn.N, status: PlanStatus.PAST_DUE },
  });
  log.info(`재시도 대상(PAST_DUE): ${pastDue.length}건`);
  await processPlans(pastDue, PlanStatus.SUSPENDED, log);
}

async function processPlans(plans: MemberPlan[], onFailStatus: string, log: Log): Promise<void> {
  let ok = 0;
  let fail = 0;
  for (const plan of plans) {
    try {
      const result = await processOne(plan, onFailStatus, log);
      if (result === 'charged' || result === 'skipped') ok += 1;
      else fail += 1;
    } catch (err) {
      fail += 1;
      log.error(`구독 처리 오류 plan=${plan.member_plan_id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info(`처리 결과: 성공 ${ok}, 실패 ${fail}`);
}

async function processOne(
  plan: MemberPlan,
  onFailStatus: string,
  log: Log,
): Promise<'charged' | 'skipped' | 'failed'> {
  // 1) 빌링키 / 플랜 로드 (트랜잭션 밖)
  const billing = plan.member_billing_id
    ? await AppDataSource.getRepository(MemberBilling).findOne({
        where: { member_billing_id: plan.member_billing_id, is_del: IsYn.N },
      })
    : null;

  // pending_plan_id(플랜 변경 예약)가 있으면 이번 결제부터 신규 플랜 적용
  const effectivePlanId = plan.pending_plan_id ?? plan.plan_id;
  const pl = await AppDataSource.getRepository(Plan).findOne({
    where: { plan_id: effectivePlanId, is_del: IsYn.N },
  });

  const cycleYm = plan.next_charge_dt ? ymd(new Date(plan.next_charge_dt)).slice(0, 7).replace('-', '') : 'NA';
  const orderId = `sub_${plan.member_plan_id}_${cycleYm}`;

  if (!billing || billing.is_active !== ActiveStatus.Y || !pl || (pl.actual_amount ?? 0) <= 0) {
    log.warn(`결제 불가(빌링/플랜 없음) plan=${plan.member_plan_id} → ${onFailStatus}`);
    await markFailed(plan, onFailStatus, orderId, null, 'NO_BILLING_OR_PLAN', '빌링키 또는 플랜이 유효하지 않음');
    return 'failed';
  }

  // 2) 멱등성 — 이번 주기 이미 결제됨?
  const existing = await AppDataSource.getRepository(Payment).findOne({ where: { order_id: orderId } });
  if (existing?.status === PaymentStatus.DONE) {
    log.info(`이미 결제됨(멱등) order=${orderId} → 결제일만 갱신`);
    await advancePlanOnly(plan, effectivePlanId);
    return 'skipped';
  }

  const amount = pl.actual_amount!;
  const grant = pl.credit ?? 0;
  const orderName = pl.plan_title ?? '구독 결제';

  // 3) 토스 자동결제 (트랜잭션 밖)
  let tossRes;
  try {
    tossRes = await chargeBilling({
      billingKey: billing.billing_key,
      customerKey: billing.customer_key,
      amount,
      orderId,
      orderName,
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    log.warn(`결제 실패 plan=${plan.member_plan_id} [${e.code}] ${e.message} → ${onFailStatus}`);
    await markFailed(plan, onFailStatus, orderId, amount, e.code ?? null, e.message ?? null);
    return 'failed';
  }

  // 4) 성공 — 결제 기록 + 크레딧 적립 + 결제일 갱신 (트랜잭션)
  await AppDataSource.transaction(async (m) => {
    const now = new Date();
    const payment = m.create(Payment, {
      member_id: plan.member_id,
      payment_type: 'CREDIT',
      purchase_type: 'SUBSCRIPTION',
      plan_id: effectivePlanId,
      grant_credit: grant,
      amount,
      currency: 'KRW',
      status: PaymentStatus.DONE,
      order_id: orderId,
      order_name: orderName,
      pg_provider: 'toss',
      payment_key: tossRes?.paymentKey ?? null,
      method: tossRes?.method ?? null,
      pg_transaction_id: tossRes?.lastTransactionKey ?? null,
      paid_at: now,
      requested_at: now,
      updated_at: now,
    });
    const savedPayment = await m.save(payment);

    if (grant > 0) {
      const start = today();
      const end = addMonthsClamped(start, CREDIT_VALID_MONTHS);
      const credit = await m.save(
        m.create(MemberCredit, {
          member_id: plan.member_id,
          credit_type: 'SUBSCRIPTION',
          init_credit: grant,
          credit: grant,
          membership_title: orderName,
          member_membership_id: plan.member_plan_id,
          start_dt: start,
          end_dt: end,
          is_del: IsYn.N,
          created_at: now,
          updated_at: now,
        }),
      );
      await m.save(
        m.create(MemberCreditLog, {
          member_credit_id: credit.member_credit_id,
          credit_action: grant,
          credit_type: 'SUBSCRIPTION',
          log_title: '구독 결제 크레딧 적립',
          log_desc: orderName,
          total_credit: grant,
          credit: grant,
          member_id: plan.member_id,
          is_member_view: IsYn.Y,
          is_partner_view: IsYn.N,
          created_at: now,
        }),
      );
    }

    const newNextCharge = addMonthsClamped(new Date(plan.next_charge_dt!), 1);
    await m.update(
      MemberPlan,
      { member_plan_id: plan.member_plan_id },
      {
        plan_id: effectivePlanId,
        pending_plan_id: null,
        status: PlanStatus.ACTIVE,
        is_active: ActiveStatus.Y,
        next_charge_dt: newNextCharge,
        end_dt: newNextCharge, // 결제 성공 시 이용기간(end_dt)도 다음 주기까지 연장
        last_payment_id: savedPayment.payment_id,
        updated_at: now,
      },
    );
  });

  log.info(`결제 성공 plan=${plan.member_plan_id} amount=${amount} credit=+${grant}`);
  return 'charged';
}

/** 실패 처리: 결제 ABORTED 기록 + 구독 상태 전이 (PAST_DUE 또는 SUSPENDED) */
async function markFailed(
  plan: MemberPlan,
  status: string,
  orderId: string,
  amount: number | null,
  failCode: string | null,
  failReason: string | null,
): Promise<void> {
  await AppDataSource.transaction(async (m: EntityManager) => {
    const now = new Date();
    await m.save(
      m.create(Payment, {
        member_id: plan.member_id,
        payment_type: 'CREDIT',
        purchase_type: 'SUBSCRIPTION',
        plan_id: plan.plan_id,
        amount,
        currency: 'KRW',
        status: PaymentStatus.ABORTED,
        order_id: `${orderId}_fail_${now.getTime()}`,
        order_name: '구독 결제 실패',
        pg_provider: 'toss',
        fail_code: failCode,
        fail_reason: failReason,
        requested_at: now,
        updated_at: now,
      }),
    );

    const patch: Partial<MemberPlan> = { status, updated_at: now };
    if (status === PlanStatus.SUSPENDED) {
      patch.is_active = ActiveStatus.N;
      patch.canceled_at = now;
    }
    await m.update(MemberPlan, { member_plan_id: plan.member_plan_id }, patch);
  });
}

/** 멱등 케이스: 이미 결제됨 → 결제일만 다음 주기로 갱신 */
async function advancePlanOnly(plan: MemberPlan, effectivePlanId: string): Promise<void> {
  const newNextCharge = addMonthsClamped(new Date(plan.next_charge_dt!), 1);
  await AppDataSource.getRepository(MemberPlan).update(
    { member_plan_id: plan.member_plan_id },
    {
      plan_id: effectivePlanId,
      pending_plan_id: null,
      status: PlanStatus.ACTIVE,
      next_charge_dt: newNextCharge,
      end_dt: newNextCharge,
      updated_at: new Date(),
    },
  );
}
