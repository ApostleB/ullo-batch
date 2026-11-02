/**
 * 백엔드 동일 표 — 백엔드 src/payment/subscription-cycle.util.spec.ts 와 입력·기대값이 같다.
 * 한쪽을 바꾸면 반드시 다른 쪽도 함께 바꾼다(주기 키·시도 번호가 어긋나면 이중 청구/누락이 생긴다).
 */
import {
  attemptOrderId,
  classifyCycle,
  cycleKey,
  cycleLikePattern,
  isCyclePeriodEnded,
  nextChargeDateAfter,
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

// 밀린 결제일 정책 — 백엔드 subscription-cycle.util.spec.ts 와 입력·기대값이 같다
describe('밀린 결제일 정책 (isCyclePeriodEnded / nextChargeDateAfter)', () => {
  const day = (s: string) => parseLocalDate(s);

  it.each([
    ['주기 시작일 + 1개월이 오늘이면 끝난 주기', '2026-10-03', '2026-11-03', true],
    ['주기 시작일 + 1개월이 내일이면 아직 진행 중인 주기', '2026-10-04', '2026-11-03', false],
    ['오늘이 결제일이면 진행 중', '2026-11-03', '2026-11-03', false],
    ['결제일이 미래여도 끝난 주기가 아니다', '2026-11-20', '2026-11-03', false],
    ['석 달 밀린 주기', '2026-08-15', '2026-11-03', true],
    ['월말 앵커 1/31 → 2/28 이 3/1 이전이면 끝남', '2026-01-31', '2026-03-01', true],
  ])('%s', (_name, cycle, todayYmd, expected) => {
    expect(isCyclePeriodEnded(cycle, day(todayYmd))).toBe(expected);
  });

  it.each([
    ['앵커 일자를 유지하며 오늘 이후로', '2026-08-15', '2026-11-03', '2026-11-15'],
    ['오늘과 같은 날은 "이후"가 아니다', '2026-08-03', '2026-11-03', '2026-12-03'],
    ['월말 앵커는 원래 일자 기준으로 계산한다(2/28 로 드리프트하지 않음)', '2026-01-31', '2026-03-01', '2026-03-31'],
    ['정상 주기는 다음 달 같은 날', '2026-11-03', '2026-11-03', '2026-12-03'],
    ['과거 주기 직전', '2026-10-04', '2026-11-03', '2026-11-04'],
  ])('%s', (_name, cycle, todayYmd, expected) => {
    expect(ymd(nextChargeDateAfter(cycle, day(todayYmd)))).toBe(expected);
  });

  it('결과는 언제나 오늘보다 뒤다', () => {
    for (const cycle of ['2020-01-31', '2025-12-31', '2026-02-28', '2026-11-03']) {
      const t = day('2026-11-03');
      expect(nextChargeDateAfter(cycle, t).getTime()).toBeGreaterThan(t.getTime());
    }
  });
});
