import { localYmdOf, pastDueTransitionedToday } from './subscription-retry-guard.util';

/** 백엔드 src/payment/subscription-retry-guard.util.spec.ts 와 같은 표다 — 한쪽을 바꾸면 함께 바꾼다. */
describe('pastDueTransitionedToday — 다음 날 재시도 강제 [P-5]', () => {
  const TODAY = '2026-11-03';
  const at = (d: number, h = 19) => new Date(2026, 10, d, h, 50, 0);
  const declined = (day: number) => ({ status: 'ABORTED', fail_code: 'CARD_LIMIT', updated_at: at(day) });

  it('PAST_DUE 가 아니면 항상 false', () => {
    expect(pastDueTransitionedToday({ status: 'ACTIVE', updated_at: at(3) }, [declined(3)], TODAY)).toBe(false);
    expect(pastDueTransitionedToday({ status: null, updated_at: at(3) }, [declined(3)], TODAY)).toBe(false);
  });

  it('오늘 카드 거절로 닫힌 시도가 있으면 true (19:50 수동 청구 거절 → 20:00 재시도 재현)', () => {
    expect(pastDueTransitionedToday({ status: 'PAST_DUE' }, [declined(3)], TODAY)).toBe(true);
  });

  it('어제 거절 전이됐으면 false (다음 날 재시도 대상)', () => {
    expect(pastDueTransitionedToday({ status: 'PAST_DUE', updated_at: at(3) }, [declined(2)], TODAY)).toBe(false);
  });

  it('오늘의 시스템 오류·운영 해소 시도는 거절 전이가 아니므로 막지 않는다', () => {
    const rows = [
      declined(2),
      { status: 'ABORTED', fail_code: 'SYSTEM_ERROR', updated_at: at(3) },
      { status: 'ABORTED', fail_code: 'ADMIN_RESOLVED_ABORT', updated_at: at(3) },
    ];
    expect(pastDueTransitionedToday({ status: 'PAST_DUE', updated_at: at(3) }, rows, TODAY)).toBe(false);
  });

  it('거절 행이 없으면(비활성 카드로 결제 행 없이 전이) 구독 갱신 시각이 오늘인지 본다', () => {
    expect(pastDueTransitionedToday({ status: 'PAST_DUE', updated_at: at(3) }, [], TODAY)).toBe(true);
    expect(pastDueTransitionedToday({ status: 'PAST_DUE', updated_at: at(2) }, [], TODAY)).toBe(false);
    expect(pastDueTransitionedToday({ status: 'PAST_DUE' }, [], TODAY)).toBe(false);
  });

  it('localYmdOf: 로컬 날짜 문자열 (UTC 변환 없음)', () => {
    expect(localYmdOf(new Date(2026, 10, 3, 0, 0, 1))).toBe('2026-11-03');
    expect(localYmdOf(new Date(2026, 10, 3, 23, 59, 59))).toBe('2026-11-03');
    expect(localYmdOf(null)).toBeNull();
    expect(localYmdOf('not a date')).toBeNull();
  });
});
