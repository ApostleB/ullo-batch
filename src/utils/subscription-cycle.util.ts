/**
 * 구독 주기 키·청구 시도 번호 — 백엔드 src/payment/subscription-cycle.util.ts 와 같은 내용(복제).
 * ⚠️ 포맷·규칙을 바꾸면 백엔드와 반드시 함께 수정한다(어긋나면 이중 청구/누락). 표는 spec 이 같다.
 */

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
