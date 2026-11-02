/**
 * 백엔드 동일 표 — 백엔드 src/payment/subscription-cycle.util.spec.ts 와 입력·기대값이 같다.
 * 한쪽을 바꾸면 반드시 다른 쪽도 함께 바꾼다(주기 키·시도 번호가 어긋나면 이중 청구/누락이 생긴다).
 */
import {
  attemptOrderId,
  classifyCycle,
  cycleKey,
  cycleLikePattern,
  nextChargeDateFrom,
} from './subscription-cycle.util';
import { parseLocalDate, ymd } from './date.util';

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

// 다음 결제일 정책 — 백엔드 subscription-cycle.util.spec.ts 와 입력·기대값이 같다.
// 다음 결제일은 "실제 청구일 + 1개월"이고, 그 값이 오늘 이후가 아니면(늦게 해소된 결제 등) 오늘 + 1개월이다.
describe('다음 결제일 정책 (nextChargeDateFrom)', () => {
  const day = (s: string) => parseLocalDate(s);

  it.each([
    ['제때 청구: 오늘 + 1개월', '2026-11-03', '2026-11-03', '2026-12-03'],
    ['늦게 청구(오늘이 실제 청구일): 오늘 + 1개월 — 이틀 연속 청구 없음', '2026-11-14', '2026-11-14', '2026-12-14'],
    ['월말 클램프: 1/31 → 2/28', '2027-01-31', '2027-01-31', '2027-02-28'],
    ['윤년 클램프: 1/31 → 2/29', '2028-01-31', '2028-01-31', '2028-02-29'],
    ['어제 청구된 건을 오늘 반영: 어제 + 1개월(오늘 이후)', '2026-11-02', '2026-11-03', '2026-12-02'],
    ['오래전 청구된 건을 오늘 반영: 오늘 + 1개월', '2026-08-15', '2026-11-03', '2026-12-03'],
    ['정확히 한 달 전 청구: 오늘과 같은 날은 "이후"가 아니라 오늘 + 1개월', '2026-10-03', '2026-11-03', '2026-12-03'],
  ])('%s', (_name, charged, todayYmd, expected) => {
    expect(ymd(nextChargeDateFrom(day(charged), day(todayYmd)))).toBe(expected);
  });

  it('결과는 언제나 오늘보다 뒤다', () => {
    const t = day('2026-11-03');
    for (const charged of ['2020-01-31', '2025-12-31', '2026-02-28', '2026-11-03', '2026-10-03']) {
      expect(nextChargeDateFrom(day(charged), t).getTime()).toBeGreaterThan(t.getTime());
    }
  });

  // R6(09 참고) — 저장된 앵커 컬럼이 없으므로 월말 클램프는 누적된다. 이중 청구는 없고 결제일만 앞당겨지는 알려진 동작이다.
  it('월말 결제일은 청구 때마다 +1개월이라 1/31 → 2/28 → 3/28 로 표류한다(알려진 동작, 이중 청구 없음)', () => {
    let d = day('2027-01-31');
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      d = nextChargeDateFrom(d, d);
      seen.push(ymd(d));
    }
    expect(seen).toEqual(['2027-02-28', '2027-03-28', '2027-04-28']);
  });
});
