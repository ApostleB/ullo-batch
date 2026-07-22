import axios from 'axios';
import { createHash } from 'crypto';
import { config } from '../config';

/**
 * KG이니시스 빌링(자동결제) 승인 클라이언트 — 모바일/INIlite 발급 빌키용 v1 API.
 *
 * ⚠️ 신형 INIlite(inilitepay.inicis.com)로 발급한 빌키는 INIAPI 2.0(/v2/pg/billing)의
 * 빌키 대장에 없어 [1195] 빌링 미등록 거래 로 거절된다(실검증 2026-07-16).
 * 승인은 반드시 v1(/api/v1/billing, form-urlencoded)로 호출한다 — 모바일 빌링키발급 매뉴얼(bill_m.html) 규격:
 * - type: 'Billing', paymethod: 'Card', authentification: '00' (전부 고정, 대소문자 주의)
 * - buyerName/buyerEmail/buyerTel 은 빈 값이면 ER0102 로 거절(필수)
 * - hashData = hex(SHA512(INIAPIKey + type + paymethod + timestamp + clientIp + mid + moid + price + billKey))
 */

export interface InipayBillingResult {
  resultCode: string; // '00' = 성공
  resultMsg: string;
  tid: string | null;
  raw: Record<string, unknown>;
}

export class InipayBillingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InipayBillingError';
  }
}

/** yyyyMMddHHmmss (INIAPI timestamp 형식) */
function dateTime14(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

export interface InipayChargeParams {
  billKey: string; // 복호화된 평문 빌링키
  orderId: string;
  amount: number;
  goodName: string;
  buyerName?: string;
  buyerEmail?: string;
  buyerTel?: string;
}

/** 빌링키 자동결제 승인 — POST /api/v1/billing (form-urlencoded). resultCode '00' 외에는 InipayBillingError */
export async function chargeInipayBilling(p: InipayChargeParams): Promise<InipayBillingResult> {
  const mid = config.inicis.billMid;
  const key = config.inicis.iniapiBillKey;
  if (!mid || !key) {
    throw new InipayBillingError(
      'NO_INICIS_CREDENTIALS',
      'INICIS_BILL_MID / INIAPI_BILL_KEY 가 설정되지 않았습니다.',
    );
  }

  const type = 'Billing';
  const paymethod = 'Card';
  const timestamp = dateTime14();
  const clientIp = '127.0.0.1';
  const price = String(p.amount);

  const hashData = createHash('sha512')
    .update(key + type + paymethod + timestamp + clientIp + mid + p.orderId + price + p.billKey)
    .digest('hex');

  const form = new URLSearchParams({
    mid,
    type,
    paymethod,
    timestamp,
    clientIp,
    moid: p.orderId,
    price,
    goodName: p.goodName,
    // buyer 3종은 필수 — 빈 값이면 ER0102(파라미터 값 오류)
    buyerName: p.buyerName || 'ullo회원',
    buyerEmail: p.buyerEmail || 'noreply@ullo.co.kr',
    buyerTel: p.buyerTel || '01000000000',
    billKey: p.billKey,
    authentification: '00',
    hashData,
  });

  let body: Record<string, any>;
  try {
    const res = await axios.post('https://iniapi.inicis.com/api/v1/billing', form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      timeout: 15000,
    });
    body = res.data ?? {};
  } catch (err) {
    const e = err as { response?: { data?: { resultCode?: string; resultMsg?: string } }; message?: string };
    const d = e.response?.data;
    throw new InipayBillingError(
      d?.resultCode ?? 'INIPAY_BILLING_FAILED',
      d?.resultMsg ?? e.message ?? '이니시스 자동결제에 실패했습니다.',
    );
  }

  if (body.resultCode !== '00') {
    throw new InipayBillingError(
      body.resultCode ?? 'INIPAY_BILLING_FAILED',
      body.resultMsg ?? '이니시스 자동결제에 실패했습니다.',
    );
  }

  return {
    resultCode: body.resultCode,
    resultMsg: body.resultMsg ?? '',
    tid: body.tid ?? null,
    raw: body,
  };
}
