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
} as const;
export type FailReasonCodeType = (typeof FailReasonCode)[keyof typeof FailReasonCode];

export const FAIL_REASON_LABELS: Record<FailReasonCodeType, string> = {
  PG_DECLINED: '카드사 거절',
  CARD_UNAVAILABLE: '결제 카드 사용 불가',
  PG_NO_RESPONSE: 'PG 응답 없음',
  SYSTEM_ERROR: '시스템 오류',
  BATCH_FAILED: '배치 실패',
  BATCH_NOT_RUN: '배치 미실행',
};

/** 배치가 payment.fail_code 에 기록하는 값(사유 코드와 같은 문자열) */
export const FAIL_CODE_BATCH_FAILED = FailReasonCode.BATCH_FAILED;
const FAIL_CODE_SYSTEM_ERROR = FailReasonCode.SYSTEM_ERROR;

type FailureState = 'PAYMENT_FAILED' | 'RETRY_PENDING';
export interface PaymentFailure {
  reason: FailReasonCodeType;
  state: FailureState;
}

const PG_NO_RESPONSE_CODES: readonly string[] = ['CONFIRM_UNKNOWN', 'CONFIRM_NO_TRANSACTION_ID', 'ADMIN_CANCEL_UNKNOWN'];
const SYSTEM_ABORTED_CODES: readonly string[] = [
  'CONFIRM_MISMATCH_CANCELED',
  'GRANT_FAILED_CANCELED',
  FAIL_CODE_SYSTEM_ERROR,
  FAIL_CODE_BATCH_FAILED,
  'ADMIN_ABORTED',
];

const stateOf = (reason: FailReasonCodeType): FailureState =>
  reason === FailReasonCode.PG_DECLINED || reason === FailReasonCode.CARD_UNAVAILABLE ? 'PAYMENT_FAILED' : 'RETRY_PENDING';
const failure = (reason: FailReasonCodeType): PaymentFailure => ({ reason, state: stateOf(reason) });

/**
 * 결제 1건의 실패 분류. 실패가 아니면(DONE·CANCELED·READY·승인 진행 중) null.
 * ABORTED + 시스템 코드 → 시스템 오류, ABORTED + 그 외 → 카드사 거절. CONFIRMING + fail_code → 결과 불명 계열(재시도대기).
 */
export function classifyPaymentFailure(p: { status: string | null; fail_code: string | null }): PaymentFailure | null {
  if (p.status === 'ABORTED') {
    const code = p.fail_code ?? '';
    if (code === FAIL_CODE_BATCH_FAILED) return failure(FailReasonCode.BATCH_FAILED);
    return SYSTEM_ABORTED_CODES.includes(code) ? failure(FailReasonCode.SYSTEM_ERROR) : failure(FailReasonCode.PG_DECLINED);
  }
  if (p.status === 'CONFIRMING' && p.fail_code) {
    if (p.fail_code === FAIL_CODE_BATCH_FAILED) return failure(FailReasonCode.BATCH_FAILED);
    if (PG_NO_RESPONSE_CODES.includes(p.fail_code)) return failure(FailReasonCode.PG_NO_RESPONSE);
    return failure(FailReasonCode.SYSTEM_ERROR);
  }
  return null;
}
