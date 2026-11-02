/**
 * 백엔드 동일 표 — 백엔드 src/payment/subscription-cycle.util.spec.ts 와 입력·기대값이 같다.
 * 한쪽을 바꾸면 반드시 다른 쪽도 함께 바꾼다(주기 키·시도 번호가 어긋나면 이중 청구/누락이 생긴다).
 */
import { attemptOrderId, classifyCycle, cycleKey, cycleLikePattern } from './subscription-cycle.util';

describe('subscription-cycle.util', () => {
  const K = 'sub_abc_202611';

  it('cycleKey 는 날짜 문자열 앞 6자리만 쓴다', () => {
    expect(cycleKey('abc', '2026-11-03')).toBe('sub_abc_202611');
    const tz = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    expect(cycleKey('abc', '2026-11-01')).toBe('sub_abc_202611');
    process.env.TZ = tz;
  });

  it('attemptOrderId', () => {
    expect(attemptOrderId(K, 2)).toBe('sub_abc_202611_2');
  });

  it('[T1] order_id===K 인 이니시스 시절 DONE 행도 done', () => {
    expect(classifyCycle([{ order_id: K, status: 'DONE' }], K).done).toBe(true);
    expect(classifyCycle([{ order_id: `${K}_1`, status: 'DONE' }], K).done).toBe(true);
  });

  it('[T2] CONFIRMING 이 있으면 confirming', () => {
    expect(classifyCycle([{ order_id: `${K}_1`, status: 'CONFIRMING' }], K).confirming).toBe(true);
  });

  it('[T13] ABORTED 시도가 있으면 다음 시도 번호', () => {
    expect(classifyCycle([{ order_id: `${K}_1`, status: 'ABORTED' }], K)).toEqual({
      done: false,
      confirming: false,
      nextAttempt: 2,
    });
    expect(classifyCycle([], K).nextAttempt).toBe(1);
  });

  it('[T3] 9번 시도가 있으면 nextAttempt=null', () => {
    expect(classifyCycle([{ order_id: `${K}_9`, status: 'ABORTED' }], K).nextAttempt).toBeNull();
  });

  it('접두 유사 행(다른 주기·다른 플랜)은 무시한다', () => {
    const rows = [
      { order_id: 'sub_abc_2026111_1', status: 'DONE' },
      { order_id: 'sub_abcd_202611_1', status: 'DONE' },
      { order_id: `${K}_x`, status: 'DONE' },
    ];
    expect(classifyCycle(rows, K)).toEqual({ done: false, confirming: false, nextAttempt: 1 });
  });

  it('cycleLikePattern 은 %, _, \\ 를 이스케이프한다', () => {
    expect(cycleLikePattern('sub_a%b\\c_202611')).toBe('sub\\_a\\%b\\\\c\\_202611\\_%');
  });
});
