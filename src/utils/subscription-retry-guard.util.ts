import { classifyPaymentFailure, FailReasonCode } from './subscription-fail-reason.util';

/**
 * "다음 날 재시도" 강제 [P-5] — PAST_DUE 구독이 **오늘** 거절 전이된 것이면 같은 날 두 번째 청구(=해지)를 하지 않는다.
 * 백엔드 복제본: src/payment/subscription-retry-guard.util.ts (한쪽을 바꾸면 함께 바꾼다).
 *
 * 판정: 이번 주기에 카드 거절(PG_DECLINED)로 닫힌 시도가 있으면 그 시도의 updated_at 이 오늘인지,
 *       없으면(비활성 카드로 결제 행 없이 전이됐거나 시스템 오류만 있는 경우) 구독 행의 updated_at 이 오늘인지 본다.
 * 시스템 오류(ABORTED+SYSTEM_ERROR 등)·운영 해소는 거절 전이가 아니므로 오늘 기록돼 있어도 재시도를 막지 않는다.
 */
export interface RetryGuardPlan {
  status: string | null;
  updated_at?: Date | string | null;
}
export interface RetryGuardPaymentRow {
  status: string | null;
  fail_code: string | null;
  updated_at?: Date | string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 시각 → 로컬 'YYYY-MM-DD' (프로세스 로컬 시간대 기준 — 호출 측 todayYmd 와 같은 기준) */
export function localYmdOf(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function pastDueTransitionedToday(plan: RetryGuardPlan, cycleRows: RetryGuardPaymentRow[], todayYmd: string): boolean {
  if ((plan.status ?? 'ACTIVE') !== 'PAST_DUE') return false;
  const declines = cycleRows.filter(
    (r) => classifyPaymentFailure({ status: r.status, fail_code: r.fail_code })?.reason === FailReasonCode.PG_DECLINED,
  );
  if (declines.length > 0) return declines.some((r) => localYmdOf(r.updated_at) === todayYmd);
  return localYmdOf(plan.updated_at) === todayYmd;
}
