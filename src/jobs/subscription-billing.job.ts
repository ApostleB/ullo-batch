import { IsNull, LessThanOrEqual } from 'typeorm';
import { AppDataSource } from '../db/data-source';
import { MemberPlan } from '../entities/member-plan.entity';
import { MemberBilling } from '../entities/member-billing.entity';
import { ActiveStatus, IsYn, PlanStatus } from '../entities/enums';
import { today } from '../utils/date.util';
import { isExplicitNonProduction } from '../utils/environment.util';
import { config } from '../config';
import { getTestMemberId } from '../utils/test-options';
import { createJobLogger } from '../logger';
import { chargeDanalPlan, OnFailStatus } from './subscription-billing.danal';

export const PRIMARY_JOB_NAME = 'subscription-billing';
export const RETRY_JOB_NAME = 'subscription-billing-retry';

type Log = ReturnType<typeof createJobLogger>;

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

/**
 * 운영 환경에서 다날 테스트 키로 청구하지 않는다. 테스트 승인이 성공으로 돌아오면 실제 돈 없이 DONE·크레딧 지급·결제일 전진이
 * 일어나기 때문이다. 키 값은 로그·예외에 남기지 않는다(변수명만).
 * 운영 판단 기준(N-9): NODE_ENV 가 명시적 비운영 값(local·development·dev·test)이 아니면 운영으로 본다. 미주입·오타도 운영이다.
 * (config.env 는 미주입일 때 'local' 이 되므로 쓰지 않고 원본 config.nodeEnv 를 본다)
 */
function assertNoProdTestKey(log: Log): void {
  if (isExplicitNonProduction(config.nodeEnv)) return;
  if (!config.danal.secretKey.startsWith(DANAL_TEST_SECRET_PREFIX)) return;
  const message = '[SECURITY] 운영 환경(또는 NODE_ENV 미지정)에 다날 테스트 키가 설정됨: DANAL_SECRET_KEY — 구독 청구를 중단합니다.';
  log.error(message);
  throw new Error(message);
}

/** 재현 테스트 전용 --member 고정. 옵션이 없으면 빈 객체라 기존 조회와 같다. */
function memberScope(): { member_id?: string } {
  const id = getTestMemberId();
  return id ? { member_id: id } : {};
}

/** 매일 21:00 — ACTIVE 구독 중 결제일 도래분 청구 */
export async function executePrimary(log: Log): Promise<void> {
  if (!batchEnabled(log)) return;
  const repo = AppDataSource.getRepository(MemberPlan);
  const only = memberScope();
  const due = await repo.find({
    where: [
      { is_del: IsYn.N, is_active: ActiveStatus.Y, status: PlanStatus.ACTIVE, next_charge_dt: LessThanOrEqual(today()), ...only },
      { is_del: IsYn.N, is_active: ActiveStatus.Y, status: IsNull(), next_charge_dt: LessThanOrEqual(today()), ...only },
    ],
  });
  log.info(`결제 대상 구독: ${due.length}건`);
  await processPlans(due, PlanStatus.PAST_DUE, log);
}

/** 매일 20:00 — 전일 실패(PAST_DUE) 구독을 1회 재시도, 재시도도 실패하면 구독 해지(CANCELED) */
export async function executeRetry(log: Log): Promise<void> {
  if (!batchEnabled(log)) return;
  const repo = AppDataSource.getRepository(MemberPlan);
  const pastDue = await repo.find({
    // is_active=N 은 어드민이 멈춘 구독이다(status 는 그대로 남는다) — 청구하면 is_active 를 Y 로 되살리게 된다.
    // 결제일이 도래한(<= 오늘) 구독만 본다: 결제일이 아직 오지 않은 PAST_DUE 를 미리 청구하지 않고 [M-2],
    // next_charge_dt 가 NULL 인 행은 비교에서 자동으로 빠진다(주기 계산이 1970년 기준으로 깨지는 것 방지).
    where: { is_del: IsYn.N, is_active: ActiveStatus.Y, status: PlanStatus.PAST_DUE, next_charge_dt: LessThanOrEqual(today()), ...memberScope() },
  });
  log.info(`재시도 대상(PAST_DUE): ${pastDue.length}건`);
  await processPlans(pastDue, PlanStatus.CANCELED, log);
}

type PlanResult = 'charged' | 'skipped' | 'failed' | 'unknown' | 'canceled';

async function processPlans(plans: MemberPlan[], onFailStatus: OnFailStatus, log: Log): Promise<void> {
  const count: Record<PlanResult | 'error', number> = {
    charged: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    canceled: 0,
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
    `처리 결과: 성공 ${count.charged}, 건너뜀 ${count.skipped}, 실패 ${count.failed}, 결과 불명 ${count.unknown}, 해지 ${count.canceled}, 오류 ${count.error}건`,
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

  // 1) 결제 카드 로드 (트랜잭션 밖)
  const billing = plan.member_billing_id
    ? await AppDataSource.getRepository(MemberBilling).findOne({
        where: { member_billing_id: plan.member_billing_id, is_del: IsYn.N },
      })
    : null;

  // PG 전환 원칙 — 다날 카드(provider=DANAL, 대소문자 무시)만 청구한다. 이전 PG(이니시스·토스·provider NULL·알 수 없는 값)와
  // 카드 정보가 없는 구독은 결제일에 청구하지 않고 구독을 해지한다(정책 3). 해지는 구독 행을 잠그고 재확인한 뒤에 해야 하므로
  // 판단은 chargeDanalPlan 이 한다(결제 행은 만들지 않는다). 토스·이니시스 호출 경로는 없다 [H-2].
  return chargeDanalPlan(plan, billing, onFailStatus, log);
}
