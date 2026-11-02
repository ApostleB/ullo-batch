/**
 * 구독 주기 키·청구 시도 번호 — 백엔드 src/payment/subscription-cycle.util.ts 와 같은 내용(복제).
 * ⚠️ 포맷·규칙을 바꾸면 백엔드와 반드시 함께 수정한다(어긋나면 이중 청구/누락). 표는 spec 이 같다.
 */
import { addMonthsClamped } from './date.util';

/** 한 주기 안에서 허용하는 최대 청구 시도 번호 (백엔드 MAX_CHARGE_ATTEMPT) */
export const MAX_CHARGE_ATTEMPT = 9;

/** 주기 키 `sub_{memberPlanId}_{YYYYMM}` — ymd('YYYY-MM-DD') 앞 6자리만 쓴다(Date 변환 금지: 타임존 하루 밀림 방지) */
export function cycleKey(memberPlanId: string, ymd: string): string {
  return `sub_${memberPlanId}_${ymd.slice(0, 4)}${ymd.slice(5, 7)}`;
}

/** 청구 시도 주문번호 `{key}_{n}` */
export function attemptOrderId(key: string, n: number): string {
  return `${key}_${n}`;
}

export interface CycleClassification {
  done: boolean;
  confirming: boolean;
  /** 다음 시도 번호. MAX_CHARGE_ATTEMPT 초과면 null */
  nextAttempt: number | null;
}

/**
 * 같은 주기의 결제 행을 분류한다.
 * order_id === key(이니시스 시절) 또는 `{key}_{숫자}` 인 행만 같은 주기로 본다.
 */
export function classifyCycle(
  rows: { order_id: string | null; status: string | null }[],
  key: string,
): CycleClassification {
  const prefix = `${key}_`;
  let done = false;
  let confirming = false;
  let maxAttempt = 0;
  for (const row of rows) {
    const orderId = row.order_id;
    if (!orderId) continue;
    if (orderId !== key) {
      if (!orderId.startsWith(prefix)) continue;
      const suffix = orderId.slice(prefix.length);
      if (!/^\d+$/.test(suffix)) continue;
      maxAttempt = Math.max(maxAttempt, Number(suffix));
    }
    if (row.status === 'DONE') done = true;
    if (row.status === 'CONFIRMING') confirming = true;
  }
  const next = maxAttempt + 1;
  return { done, confirming, nextAttempt: next > MAX_CHARGE_ATTEMPT ? null : next };
}

/** `LIKE ... ESCAPE '\'` 용 패턴 — `{escaped key}\_%` */
export function cycleLikePattern(key: string): string {
  return `${key.replace(/[\\%_]/g, (c) => `\\${c}`)}\\_%`;
}

/**
 * 다음 결제일 정책(백엔드 subscription-cycle.util.ts 와 같은 규칙):
 * 다음 결제일은 "실제 청구일 + 1개월"이다. 배치가 못 돈 날의 지난 주기는 다음 실행에서 한 번만 청구하고(청구 없이 재설정하지 않는다),
 * 그 청구일 기준으로 다음 결제일을 잡으므로 이틀 연속 청구가 생기지 않는다.
 * 계산한 값이 오늘 이후가 아니면(오래전에 청구된 건을 뒤늦게 반영하는 해소 등) 오늘 + 1개월로 잡아 과거 결제일이 남지 않게 한다.
 * @param chargedDate 실제 청구한 날(로컬 자정). 일반 청구는 오늘
 * @param todayLocal 오늘 로컬 자정
 */
export function nextChargeDateFrom(chargedDate: Date, todayLocal: Date): Date {
  const next = addMonthsClamped(chargedDate, 1);
  return next.getTime() > todayLocal.getTime() ? next : addMonthsClamped(todayLocal, 1);
}
