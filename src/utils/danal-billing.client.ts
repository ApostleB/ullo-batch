import axios from 'axios';
import { config } from '../config';

/**
 * 다날 ONE API 빌링 호출 — 백엔드 src/payment/danal.client.ts 의 confirmBilling/cancel 과 같은 규격(복제).
 * 3분류: 설정 누락(Error) / 다날이 code 로 거절(DanalApiError) / 결과 불명(DanalResultUnknownError).
 * 비밀키·빌링키가 담긴 axios 오류 원문과 요청 경로(빌링키 포함 가능)는 로그·예외 메시지에 내지 않는다.
 */

const REQUEST_TIMEOUT_MS = 15000;
const SUCCESS_CODE = 'SUCCESS';
const METHOD_CARD = 'CARD';
const CANCEL_REASON_MAX_BYTES = 255;
const ORDER_NAME_MAX_BYTES = 80;

/**
 * 다날 응답 실패의 성격 — 백엔드 src/payment/danal.client.ts 의 classifyDanalFailure 와 같다(복제).
 * CARD_DECLINED 는 카드사 거절로 확정해 구독 상태를 전이해도 되는 경우, NON_CARD 는 가맹점·인증·계약·요청·호출 한도 오류처럼
 * 카드와 무관해 구독 상태를 바꾸면 안 되는 경우다.
 */
export type DanalFailureKind = 'CARD_DECLINED' | 'NON_CARD';

/** 가맹점·인증·계약·요청 형식·호출 한도 오류로 보이는 code 패턴 — 다날 오류 코드 표(Q-B11) 답변 전까지의 보수적 임시 분류 */
const NON_CARD_CODE_PATTERN =
  /UNAUTHORIZED|UNAUTHENTICATED|FORBIDDEN|SECRET|API_?KEY|MERCHANT|CONTRACT|PERMISSION|NOT_ALLOWED|TOO_MANY|RATE_?LIMIT|THROTTL|INVALID_(REQUEST|PARAM)|BAD_REQUEST|MAINTENANCE|SERVICE_UNAVAILABLE|\bIP\b/i;

/** 2xx 가 아닌 응답은 code 와 무관하게 카드 거절이 아니다. 2xx 비SUCCESS 는 code 패턴으로 구분한다. */
export function classifyDanalFailure(httpStatus: number, code: string): DanalFailureKind {
  if (httpStatus < 200 || httpStatus >= 300) return 'NON_CARD';
  return NON_CARD_CODE_PATTERN.test(code) ? 'NON_CARD' : 'CARD_DECLINED';
}

/** 다날이 실패 code 를 명시적으로 돌려준 경우 — HTTP 상태를 함께 싣는다. 카드 거절인지는 isCardDecline 으로 본다. */
export class DanalApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 200,
  ) {
    super(message);
    this.name = 'DanalApiError';
  }

  /** 카드사 거절로 확정할 수 있는가 — false 면 구독 상태를 바꾸지 말고 시스템 오류로 기록한다 */
  get isCardDecline(): boolean {
    return classifyDanalFailure(this.httpStatus, this.code) === 'CARD_DECLINED';
  }
}

/** 타임아웃·연결 오류·5xx·형식 오류 — 다날 쪽 처리 결과를 알 수 없다. 같은 orderId 로 재호출하지 않는다 */
export class DanalResultUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DanalResultUnknownError';
  }
}

export interface DanalConfirmBillingInput {
  billingKey: string;
  userId: string;
  amount: number;
  orderName: string;
  orderId: string;
}

export interface DanalConfirmBillingResult {
  transactionId: string | null;
  orderId: string | null;
  amount: number | null;
}

export interface DanalCancelInput {
  transactionId: string;
  amount: number;
  cancelType: 'C';
  cancelReason?: string;
}

/** UTF-8 바이트 한도 안으로 문자 단위로 자른다 */
function truncateUtf8(value: string, maxBytes: number): string {
  let bytes = 0;
  let out = '';
  for (const ch of value) {
    bytes += Buffer.byteLength(ch);
    if (bytes > maxBytes) break;
    out += ch;
  }
  return out;
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

const asAmount = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

function required(name: 'DANAL_SECRET_KEY' | 'DANAL_MERCHANT_ID', value: string): string {
  if (!value) throw new Error(`${name} 가 설정되지 않았습니다.`);
  return value;
}

/** 빌링키 승인(정기 청구). 응답 필드가 없으면 null — 호출 측이 fail-closed 로 대조한다. */
export async function confirmBilling(input: DanalConfirmBillingInput): Promise<DanalConfirmBillingResult> {
  const data = await post('/billing/confirm', {
    method: METHOD_CARD,
    billingKey: input.billingKey,
    userId: input.userId,
    amount: input.amount,
    orderName: truncateUtf8(input.orderName, ORDER_NAME_MAX_BYTES),
    merchantId: required('DANAL_MERCHANT_ID', config.danal.merchantId),
    orderId: input.orderId,
  });
  return {
    transactionId: asString(data.transactionId),
    orderId: asString(data.orderId),
    amount: asAmount(data.amount),
  };
}

/** 승인 취소(보상). 전체 취소(C)만 쓴다. */
export async function cancel(input: DanalCancelInput): Promise<{ transactionId: string | null }> {
  const data = await post('/payments/cancel', {
    method: METHOD_CARD,
    transactionId: input.transactionId,
    merchantId: required('DANAL_MERCHANT_ID', config.danal.merchantId),
    amount: input.amount,
    cancelType: input.cancelType,
    ...(input.cancelReason ? { cancelReason: truncateUtf8(input.cancelReason, CANCEL_REASON_MAX_BYTES) } : {}),
  });
  return { transactionId: asString(data.transactionId) };
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const secret = required('DANAL_SECRET_KEY', config.danal.secretKey);
  const base = (config.danal.apiBaseUrl || '').replace(/\/$/, '');

  let res: { status: number; data: unknown };
  try {
    res = await axios.post(`${base}${path}`, body, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${secret}:`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });
  } catch (err) {
    // axios 오류 원문(요청 헤더·본문 포함)은 버리고 코드만 남긴다
    const code = (err as { code?: string }).code ?? 'NETWORK_ERROR';
    throw new DanalResultUnknownError(`다날 응답을 받지 못했습니다. (${code})`);
  }

  // 5xx 는 code 가 있어도 내부 처리 여부를 알 수 없다 — 명시적 실패로 닫지 않는다
  if (res.status >= 500) {
    throw new DanalResultUnknownError(`다날 서버 오류로 처리 결과를 알 수 없습니다. (HTTP ${res.status})`);
  }

  const data = res.data as Record<string, unknown> | null;
  const code = data && typeof data === 'object' ? asString(data.code) : null;
  if (!data || !code) {
    throw new DanalResultUnknownError(`다날 응답 형식을 해석할 수 없습니다. (HTTP ${res.status})`);
  }
  if (code !== SUCCESS_CODE) {
    throw new DanalApiError(code, asString(data.message) ?? '다날 요청이 실패했습니다.', res.status);
  }
  return data;
}
