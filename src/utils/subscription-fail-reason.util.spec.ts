import {
  FAIL_CODE_BATCH_FAILED,
  FAIL_REASON_LABELS,
  FailReasonCode,
  classifyPaymentFailure,
} from './subscription-fail-reason.util';

/**
 * 백엔드 src/payment/subscription-display.util.spec.ts 와 같은 표다 — 한쪽을 바꾸면 반드시 함께 바꾼다.
 * (배치는 BATCH_FAILED 를 기록하고, 백엔드는 같은 코드를 읽어 화면 상태로 변환한다)
 */
describe('실패 사유 코드값·라벨 (백엔드와 일치)', () => {
  it('요청한 4개 사유 코드와 한글 라벨을 갖는다', () => {
    expect(FAIL_REASON_LABELS[FailReasonCode.BATCH_FAILED]).toBe('배치 실패');
    expect(FAIL_REASON_LABELS[FailReasonCode.BATCH_NOT_RUN]).toBe('배치 미실행');
    expect(FAIL_REASON_LABELS[FailReasonCode.PG_NO_RESPONSE]).toBe('PG 응답 없음');
    expect(FAIL_REASON_LABELS[FailReasonCode.SYSTEM_ERROR]).toBe('시스템 오류');
    expect(FAIL_REASON_LABELS[FailReasonCode.PG_DECLINED]).toBe('카드사 거절');
    expect(FAIL_REASON_LABELS[FailReasonCode.CARD_UNAVAILABLE]).toBe('결제 카드 사용 불가');
    expect(FAIL_REASON_LABELS[FailReasonCode.ADMIN_RESOLVED]).toBe('운영자 해소'); // [P-3]
  });

  it('배치가 payment.fail_code 에 기록하는 값은 사유 코드와 같은 문자열이다', () => {
    expect(FAIL_CODE_BATCH_FAILED).toBe('BATCH_FAILED');
  });
});

describe('classifyPaymentFailure — payment.status/fail_code → 사유 (백엔드와 일치)', () => {
  it.each([
    ['ABORTED', 'DANAL_4001', FailReasonCode.PG_DECLINED, 'PAYMENT_FAILED'],
    ['ABORTED', '', FailReasonCode.PG_DECLINED, 'PAYMENT_FAILED'],
    ['CONFIRMING', 'CONFIRM_UNKNOWN', FailReasonCode.PG_NO_RESPONSE, 'RETRY_PENDING'],
    ['CONFIRMING', 'CONFIRM_NO_TRANSACTION_ID', FailReasonCode.PG_NO_RESPONSE, 'RETRY_PENDING'],
    ['CONFIRMING', 'ADMIN_CANCEL_UNKNOWN', FailReasonCode.PG_NO_RESPONSE, 'RETRY_PENDING'],
    ['CONFIRMING', 'CONFIRM_MISMATCH_CANCEL_FAILED', FailReasonCode.SYSTEM_ERROR, 'RETRY_PENDING'],
    ['CONFIRMING', 'GRANT_FAILED_UNVERIFIED', FailReasonCode.SYSTEM_ERROR, 'RETRY_PENDING'],
    ['CONFIRMING', 'GRANT_FAILED_CANCEL_FAILED', FailReasonCode.SYSTEM_ERROR, 'RETRY_PENDING'],
    ['CONFIRMING', 'DUPLICATE_TRANSACTION_ID', FailReasonCode.SYSTEM_ERROR, 'RETRY_PENDING'],
    ['CONFIRMING', 'PAYMENT_STATE_CHANGED', FailReasonCode.SYSTEM_ERROR, 'RETRY_PENDING'],
    ['CONFIRMING', 'SYSTEM_ERROR', FailReasonCode.SYSTEM_ERROR, 'RETRY_PENDING'],
    ['ABORTED', 'CONFIRM_MISMATCH_CANCELED', FailReasonCode.SYSTEM_ERROR, 'RETRY_PENDING'],
    ['ABORTED', 'GRANT_FAILED_CANCELED', FailReasonCode.SYSTEM_ERROR, 'RETRY_PENDING'],
    ['ABORTED', 'SYSTEM_ERROR', FailReasonCode.SYSTEM_ERROR, 'RETRY_PENDING'],
    ['CONFIRMING', 'BATCH_FAILED', FailReasonCode.BATCH_FAILED, 'RETRY_PENDING'],
    // [P-3] 운영자가 미승인·취소로 해소한 건은 카드사 거절이 아니다
    ['ABORTED', 'ADMIN_RESOLVED_ABORT', FailReasonCode.ADMIN_RESOLVED, 'RETRY_PENDING'],
    ['ABORTED', 'ADMIN_RESOLVED_CANCELED', FailReasonCode.ADMIN_RESOLVED, 'RETRY_PENDING'],
    ['ABORTED', 'ADMIN_ABORTED', FailReasonCode.ADMIN_RESOLVED, 'RETRY_PENDING'],
    ['CONFIRMING', 'SOMETHING_NEW', FailReasonCode.SYSTEM_ERROR, 'RETRY_PENDING'],
  ])('%s + %s → %s (%s)', (status, failCode, reason, state) => {
    expect(classifyPaymentFailure({ status, fail_code: failCode })).toEqual({ reason, state });
  });

  it.each([
    ['DONE', null],
    ['CANCELED', null],
    ['READY', null],
    ['CONFIRMING', null],
    [null, null],
  ])('%s + %s 는 실패가 아니다', (status, failCode) => {
    expect(classifyPaymentFailure({ status, fail_code: failCode })).toBeNull();
  });
});

describe('[P-4] 처리가 끊긴 CONFIRMING (백엔드와 일치)', () => {
  const NOW = new Date(2026, 10, 10, 12, 0, 0);
  const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);

  it('fail_code 없는 CONFIRMING 은 2분 안에는 진행 중, 2분 넘으면 PG 응답 없음(재시도대기)', () => {
    expect(classifyPaymentFailure({ status: 'CONFIRMING', fail_code: null, updated_at: at(1) }, NOW)).toBeNull();
    expect(classifyPaymentFailure({ status: 'CONFIRMING', fail_code: null, updated_at: at(10) }, NOW)).toEqual({
      reason: FailReasonCode.PG_NO_RESPONSE,
      state: 'RETRY_PENDING',
    });
    // 갱신 시각을 모르면 진행 중으로 본다
    expect(classifyPaymentFailure({ status: 'CONFIRMING', fail_code: null }, NOW)).toBeNull();
  });
});
