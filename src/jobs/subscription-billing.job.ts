import { EntityManager, IsNull, LessThanOrEqual, Not } from 'typeorm';
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
import { config } from '../config';
import { createJobLogger } from '../logger';
import { advancePlanOnly, chargeDanalPlan, OnFailStatus } from './subscription-billing.danal';

export const PRIMARY_JOB_NAME = 'subscription-billing';
export const RETRY_JOB_NAME = 'subscription-billing-retry';

/** 크레딧 유효기간(개월) — 결제일로부터 3개월 (백엔드 단건·구독 적립과 공통 정책) */
const CREDIT_VALID_MONTHS = 3;

type Log = ReturnType<typeof createJobLogger>;

/** PG 무관하게 결제 성공 결과를 표준화 — Payment 기록에 그대로 매핑된다. (이 잡의 토스 레거시 경로 전용) */
interface ChargeResult {
  pgProvider: string; // 'toss'
  paymentKey: string | null;
  method: string | null;
  transactionId: string | null;
}

/**
 * 운영 게이트 — DANAL_BILLING_BATCH_ENABLED 가 정확히 'true' 가 아니면 DB 조회도 청구도 하지 않는다.
 * (스케줄러 등록도 꺼져 있고, CLI 수동 실행 `npm run job billing` 도 이 게이트를 따른다)
 */
function batchEnabled(log: Log): boolean {
  if (!config.danal.batchEnabled) {
    log.info('DANAL_BILLING_BATCH_ENABLED 가 켜져 있지 않아 구독 청구를 실행하지 않습니다.');
    return false;
  }
  assertNoProdTestKey(log);
  return true;
}

/** 다날 테스트 키 접두사 — 백엔드 assertNoDanalTestKeys 와 같다 */
const DANAL_TEST_SECRET_PREFIX = 'SK_TEST_';
const PRODUCTION_ENVS: readonly string[] = ['prod', 'production'];

/**
 * 운영 환경에서 다날 테스트 키로 청구하지 않는다. 테스트 승인이 성공으로 돌아오면 실제 돈 없이 DONE·크레딧 지급·결제일 전진이
 * 일어나기 때문이다. 키 값은 로그·예외에 남기지 않는다(변수명만).
 */
function assertNoProdTestKey(log: Log): void {
  if (!PRODUCTION_ENVS.includes(String(config.env).toLowerCase())) return;
  if (!config.danal.secretKey.startsWith(DANAL_TEST_SECRET_PREFIX)) return;
  const message = '[SECURITY] 운영 환경에 다날 테스트 키가 설정됨: DANAL_SECRET_KEY — 구독 청구를 중단합니다.';
  log.error(message);
  throw new Error(message);
}

/** 매일 21:00 — ACTIVE 구독 중 결제일 도래분 청구 */
export async function executePrimary(log: Log): Promise<void> {
  if (!batchEnabled(log)) return;
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
  if (!batchEnabled(log)) return;
  const repo = AppDataSource.getRepository(MemberPlan);
  // next_charge_dt가 null이면 결제 주기 계산이 1970년 기준으로 깨지므로 대상에서 제외한다.
  const pastDue = await repo.find({
    // is_active=N 은 어드민이 멈춘 구독이다(status 는 그대로 남는다) — 청구하면 is_active 를 Y 로 되살리게 된다.
    where: { is_del: IsYn.N, is_active: ActiveStatus.Y, status: PlanStatus.PAST_DUE, next_charge_dt: Not(IsNull()) },
  });
  log.info(`재시도 대상(PAST_DUE): ${pastDue.length}건`);
  await processPlans(pastDue, PlanStatus.SUSPENDED, log);
}

type PlanResult = 'charged' | 'skipped' | 'failed' | 'unknown' | 'reregister';

async function processPlans(plans: MemberPlan[], onFailStatus: OnFailStatus, log: Log): Promise<void> {
  const count: Record<PlanResult | 'error', number> = {
    charged: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    reregister: 0,
    error: 0,
  };
  for (const plan of plans) {
    try {
      count[await processOne(plan, onFailStatus, log)] += 1;
    } catch (err) {
      count.error += 1;
      log.error(`구독 처리 오류 plan=${plan.member_plan_id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info(
    `처리 결과: 성공 ${count.charged}, 건너뜀 ${count.skipped}, 실패 ${count.failed}, 결과 불명 ${count.unknown}, 오류 ${count.error}, 재등록 필요 ${count.reregister}건`,
  );
  if (count.unknown > 0) {
    log.error(`[CRITICAL] 결과 불명 ${count.unknown}건 — 다날 관리자 화면 확인 후 어드민에서 해소해야 합니다.`);
  }
}

async function processOne(plan: MemberPlan, onFailStatus: OnFailStatus, log: Log): Promise<PlanResult> {
  // 0) next_charge_dt 없으면 결제 주기 계산 불가 — 안전하게 스킵 (쿼리에서 거르지만 방어적으로 재확인)
  if (!plan.next_charge_dt) {
    log.warn(`next_charge_dt 없음 — 결제 스킵 plan=${plan.member_plan_id}`);
    return 'skipped';
  }

  // 1) 빌링키 / 플랜 로드 (트랜잭션 밖)
  const billing = plan.member_billing_id
    ? await AppDataSource.getRepository(MemberBilling).findOne({
        where: { member_billing_id: plan.member_billing_id, is_del: IsYn.N },
      })
    : null;

  // 카드의 PG(provider)로 분기한다. 대소문자는 무시한다.
  //  - DANAL : 다날 빌링 (subscription-billing.danal.ts)
  //  - INICIS: 이니시스 시절 카드 — 청구하지 않고 건너뛴다(상태·결제 행 불변). 사용자가 재등록해야 한다.
  //  - 그 외(NULL, TOSS): 아래 레거시 토스 경로
  const provider = (billing?.provider ?? '').toUpperCase();
  if (billing && provider === 'DANAL') return chargeDanalPlan(plan, billing, onFailStatus, log);
  if (billing && provider === 'INICIS') {
    log.warn(`이니시스 카드 — 재등록 필요, 청구하지 않음 plan=${plan.member_plan_id}`);
    return 'reregister';
  }

  // pending_plan_id(플랜 변경 예약)가 있으면 이번 결제부터 신규 플랜 적용
  const effectivePlanId = plan.pending_plan_id ?? plan.plan_id;
  const pl = await AppDataSource.getRepository(Plan).findOne({
    where: { plan_id: effectivePlanId, is_del: IsYn.N },
  });

  const cycleYm = plan.next_charge_dt ? ymd(new Date(plan.next_charge_dt)).slice(0, 7).replace('-', '') : 'NA';
  const orderId = `sub_${plan.member_plan_id}_${cycleYm}`;

  if (!billing || billing.is_active !== ActiveStatus.Y || !pl || (pl.actual_amount ?? 0) <= 0) {
    log.warn(`결제 불가(빌링/플랜 없음) plan=${plan.member_plan_id} → ${onFailStatus}`);
    await markFailed(plan, onFailStatus, orderId, null, 'NO_BILLING_OR_PLAN', '빌링키 또는 플랜이 유효하지 않음', 'inicis');
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

  // 3) 자동결제 (트랜잭션 밖) — 여기까지 온 카드는 레거시 토스 빌링키(provider NULL 또는 'TOSS')뿐이다.
  let charge: ChargeResult;
  try {
    const r = await chargeBilling({
      billingKey: billing.billing_key,
      customerKey: billing.customer_key,
      amount,
      orderId,
      orderName,
    });
    charge = {
      pgProvider: 'toss',
      paymentKey: r?.paymentKey ?? null,
      method: r?.method ?? null,
      transactionId: r?.lastTransactionKey ?? null,
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    log.warn(`결제 실패 plan=${plan.member_plan_id} provider=toss [${e.code}] ${e.message} → ${onFailStatus}`);
    await markFailed(plan, onFailStatus, orderId, amount, e.code ?? null, e.message ?? null, 'toss');
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
      pg_provider: charge.pgProvider,
      payment_key: charge.paymentKey,
      method: charge.method,
      pg_transaction_id: charge.transactionId,
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
  pgProvider: string = 'inicis',
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
        pg_provider: pgProvider,
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
