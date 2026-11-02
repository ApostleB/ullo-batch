/**
 * 구독 실패 사유 코드 — 백엔드 src/payment/subscription-display.util.ts 와 같은 값·같은 분류표다(복제).
 * 배치는 payment.fail_code 에 BATCH_FAILED 를 기록하고, 백엔드가 이 값을 읽어 화면 상태(재시도대기)·사유 라벨로 변환한다.
 * 한쪽을 바꾸면 반드시 함께 바꾼다(spec 표도 같다).
 */

export const FailReasonCode = {
  /** 카드사(PG)가 거절 */
  PG_DECLINED: 'PG_DECLINED',
  /** 결제 카드 사용 불가(비활성 카드) */
  CARD_UNAVAILABLE: 'CARD_UNAVAILABLE',
  /** PG 응답 없음·결과 불명 */
  PG_NO_RESPONSE: 'PG_NO_RESPONSE',
  /** 시스템 오류 */
  SYSTEM_ERROR: 'SYSTEM_ERROR',
  /** 배치가 이 구독을 처리하다 실패 */
  BATCH_FAILED: 'BATCH_FAILED',
  /** 결제일이 지났는데 배치가 청구하지 않음(조회 시 계산, 기록하지 않는다) */
  BATCH_NOT_RUN: 'BATCH_NOT_RUN',
  /** 운영자가 다날에서 미승인·취소를 확인해 해소한 건 — 카드사 거절이 아니다 [P-3] */
  ADMIN_RESOLVED: 'ADMIN_RESOLVED',
} as const;
export type FailReasonCodeType = (typeof FailReasonCode)[keyof typeof FailReasonCode];

export const FAIL_REASON_LABELS: Record<FailReasonCodeType, string> = {
  PG_DECLINED: '카드사 거절',
  CARD_UNAVAILABLE: '결제 카드 사용 불가',
  PG_NO_RESPONSE: 'PG 응답 없음',
  SYSTEM_ERROR: '시스템 오류',
  BATCH_FAILED: '배치 실패',
  BATCH_NOT_RUN: '배치 미실행',
  ADMIN_RESOLVED: '운영자 해소',
};

/** 배치가 payment.fail_code 에 기록하는 값(사유 코드와 같은 문자열) */
export const FAIL_CODE_BATCH_FAILED = FailReasonCode.BATCH_FAILED;
export const FAIL_CODE_SYSTEM_ERROR = FailReasonCode.SYSTEM_ERROR;

type FailureState = 'PAYMENT_FAILED' | 'RETRY_PENDING';
export interface PaymentFailure {
  reason: FailReasonCodeType;
  state: FailureState;
}

const PG_NO_RESPONSE_CODES: readonly string[] = ['CONFIRM_UNKNOWN', 'CONFIRM_NO_TRANSACTION_ID', 'ADMIN_CANCEL_UNKNOWN'];
/** 운영자가 해소한 건 — 카드사 거절이 아니다 [P-3]. `ADMIN_` 접두는 모두 운영자 처리로 본다. */
const ADMIN_RESOLVED_CODES: readonly string[] = ['ADMIN_RESOLVED_ABORT', 'ADMIN_RESOLVED_CANCELED', 'ADMIN_ABORTED'];
const SYSTEM_ABORTED_CODES: readonly string[] = [
  'CONFIRM_MISMATCH_CANCELED',
  'GRANT_FAILED_CANCELED',
  FAIL_CODE_SYSTEM_ERROR,
  FAIL_CODE_BATCH_FAILED,
];
/** 이보다 오래된 CONFIRMING(fail_code 없음)은 처리가 끊긴 것이다 [P-4] — 어드민 해소 가능 기준(2분)과 같다 */
export const CONFIRMING_STALE_MS = 2 * 60 * 1000;

const stateOf = (reason: FailReasonCodeType): FailureState =>
  reason === FailReasonCode.PG_DECLINED || reason === FailReasonCode.CARD_UNAVAILABLE ? 'PAYMENT_FAILED' : 'RETRY_PENDING';
const failure = (reason: FailReasonCodeType): PaymentFailure => ({ reason, state: stateOf(reason) });

const toTime = (v: Date | string | null | undefined): number | null => {
  if (!v) return null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(t) ? null : t;
};

/**
 * 결제 1건의 실패 분류. 실패가 아니면(DONE·CANCELED·READY·승인 진행 중) null.
 * ABORTED + 시스템 코드 → 시스템 오류, ABORTED + 운영자 해소 코드 → 운영자 해소, ABORTED + 그 외 → 카드사 거절.
 * CONFIRMING + fail_code → 결과 불명 계열(재시도대기). CONFIRMING + fail_code 없음 → 진행 중, 단 2분 넘었으면 PG 응답 없음 [P-4].
 */
export function classifyPaymentFailure(
  p: { status: string | null; fail_code: string | null; updated_at?: Date | string | null },
  now: Date = new Date(),
): PaymentFailure | null {
  if (p.status === 'ABORTED') {
    const code = p.fail_code ?? '';
    if (code === FAIL_CODE_BATCH_FAILED) return failure(FailReasonCode.BATCH_FAILED);
    if (ADMIN_RESOLVED_CODES.includes(code) || code.startsWith('ADMIN_')) return failure(FailReasonCode.ADMIN_RESOLVED);
    return SYSTEM_ABORTED_CODES.includes(code) ? failure(FailReasonCode.SYSTEM_ERROR) : failure(FailReasonCode.PG_DECLINED);
  }
  if (p.status === 'CONFIRMING' && p.fail_code) {
    if (p.fail_code === FAIL_CODE_BATCH_FAILED) return failure(FailReasonCode.BATCH_FAILED);
    if (PG_NO_RESPONSE_CODES.includes(p.fail_code)) return failure(FailReasonCode.PG_NO_RESPONSE);
    return failure(FailReasonCode.SYSTEM_ERROR);
  }
  if (p.status === 'CONFIRMING') {
    const at = toTime(p.updated_at);
    if (at !== null && now.getTime() - at >= CONFIRMING_STALE_MS) return failure(FailReasonCode.PG_NO_RESPONSE);
  }
  return null;
}
