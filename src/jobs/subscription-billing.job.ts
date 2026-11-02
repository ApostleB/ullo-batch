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

type PlanResult = 'charged' | 'skipped' | 'failed' | 'declined' | 'system_error' | 'unknown' | 'canceled';

/** 다날을 실제로 호출한 결과 — 중단 판단의 표본. 건너뜀·해지·비활성 카드 전이('failed')는 다날을 호출하지 않았거나 시스템 문제라 제외한다. */
const ATTEMPTED: readonly PlanResult[] = ['charged', 'declined', 'system_error', 'unknown'];
/** 이상 징후로 세는 결과 — 카드 거절과 다날의 비카드 오류 */
const SUSPICIOUS: readonly PlanResult[] = ['declined', 'system_error'];

/**
 * 잡 중단 임계 [P-1]. 한 잡에서 다날 호출 N건 중 (거절 + 비카드 오류)의 비율이 ratio 를 **넘으면** 남은 구독을 처리하지 않고 [CRITICAL] 로 중단한다.
 * - 비율 0.5: 정상 구독 카드의 월 정기결제 거절률은 한 자릿수~십수 %다. 거절이 성공보다 많으면(>50%) 카드가 아니라 우리 쪽·다날 쪽 문제
 *   (비밀키 교체 실수, 계약 만료, 코드 오분류)일 가능성이 압도적이다.
 * - 최소 표본 5건: 첫 몇 건으로 판단하면 우연한 거절 몇 건에 멈춘다. 5건에서 비율을 넘으려면 거절이 3건 이상이므로,
 *   되돌릴 수 없는 해지(재시도 잡의 거절 전이)가 이상 상황에서 난 뒤 멈추더라도 최대 3~4건에 그친다. 대상이 5건 미만인 날은 어차피 소량이다.
 * 값은 DANAL_BILLING_ABORT_RATIO / DANAL_BILLING_ABORT_MIN_SAMPLE 로 바꾼다. 설정이 없는 환경(구 설정·테스트)도 기본값으로 동작한다.
 */
function abortThresholds(): { ratio: number; minSample: number } {
  const d = config.danal as { billingAbortRatio?: number; billingAbortMinSample?: number };
  return { ratio: d.billingAbortRatio ?? 0.5, minSample: d.billingAbortMinSample ?? 5 };
}

async function processPlans(plans: MemberPlan[], onFailStatus: OnFailStatus, log: Log): Promise<void> {
  const count: Record<PlanResult | 'error', number> = {
    charged: 0,
    skipped: 0,
    failed: 0,
    declined: 0,
    system_error: 0,
    unknown: 0,
    canceled: 0,
    error: 0,
  };
  const threshold = abortThresholds();
  let attempted = 0;
  let suspicious = 0;
  let aborted = false;
  let processed = 0;
  for (const plan of plans) {
    processed += 1;
    try {
      const result = await processOne(plan, onFailStatus, log);
      count[result] += 1;
      if (ATTEMPTED.includes(result)) attempted += 1;
      if (SUSPICIOUS.includes(result)) suspicious += 1;
    } catch (err) {
      count.error += 1;
      log.error(`구독 처리 오류 plan=${plan.member_plan_id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (attempted >= threshold.minSample && suspicious / attempted > threshold.ratio) {
      aborted = true;
      break;
    }
  }
  // 요약의 '실패'는 카드 거절과 그 밖의 확실한 실패를 합친 값이다(기존 형식 유지). 다날 비카드 오류는 아래에 별도로 알린다.
  log.info(
    `처리 결과: 성공 ${count.charged}, 건너뜀 ${count.skipped}, 실패 ${count.failed + count.declined}, 결과 불명 ${count.unknown}, 해지 ${count.canceled}, 오류 ${count.error}건`,
  );
  if (count.system_error > 0) {
    log.error(
      `[CRITICAL] 다날이 카드 거절이 아닌 오류를 돌려준 건 ${count.system_error}건 — 구독 상태는 바꾸지 않았고 다음 실행에서 다시 청구합니다. 다날 키·계약·요청 형식을 확인하세요.`,
    );
  }
  if (count.unknown > 0) {
    log.error(`[CRITICAL] 결과 불명 ${count.unknown}건 — 다날 관리자 화면 확인 후 어드민에서 해소해야 합니다.`);
  }
  if (aborted) {
    const message =
      `[CRITICAL] 다날 호출 ${attempted}건 중 카드 거절 ${count.declined}건·다날 비카드 오류 ${count.system_error}건으로 비율 ` +
      `${(suspicious / attempted).toFixed(2)} 가 임계 ${threshold.ratio} 를 넘어 청구를 중단합니다. ` +
      `남은 ${plans.length - processed}건은 건드리지 않았습니다. 원인(다날 키·계약·응답 형식)을 확인한 뒤 다시 실행하세요.`;
    log.error(message);
    throw new Error(message);
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
