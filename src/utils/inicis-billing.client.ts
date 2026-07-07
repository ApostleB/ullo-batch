import axios from 'axios';
import { createHash } from 'crypto';
import { config } from '../config';

/**
 * KG이니시스(INIpay) 빌링 자동결제 클라이언트 (배치용).
 * ullo/src/payment/inipay.client.ts 의 chargeBilling 과 동일한 INIAPI 2.0 빌링 승인 로직을
 * NestControlle 의존 없이 배치 스타일(단일 함수)로 옮긴 것.
 *
 * 인증: hashData = hex(SHA512(key + mid + type + timestamp + JSON(data)))  (백슬래시 제거)
 * 자격증명: INICIS_BILL_MID(빌링 MID) + INIAPI_BILL_KEY(빌링 MID의 INIAPI 2.0 key)
 */
export interface InicisBillingResult {
  resultCode: string; // '00' = 성공
  resultMsg: string;
  tid: string | null;
  method: string | null;
}

export class InicisBillingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InicisBillingError';
  }
}

export interface InicisChargeParams {
  billKey: string;
  amount: number;
  orderId: string;
  orderName: string;
  buyerName?: string;
  buyerEmail?: string;
  buyerTel?: string;
}

/** yyyyMMddHHmmss (INIAPI timestamp 형식) */
function dateTime14(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/** INIAPI 2.0 hashData — 샘플과 동일하게 백슬래시 제거 후 SHA512(hex) */
function iniapiHash(key: string, mid: string, type: string, timestamp: string, data: object): string {
  const plainTxt = (key + mid + type + timestamp + JSON.stringify(data)).replace(/\\/g, '');
  return createHash('sha512').update(plainTxt).digest('hex');
}

/**
 * billKey 로 자동결제 승인 — POST /v2/pg/billing.
 * resultCode '00' 외에는 InicisBillingError(code, message) throw.
 */
export async function chargeInicisBilling(p: InicisChargeParams): Promise<InicisBillingResult> {
  const mid = config.inicis.billMid;
  const key = config.inicis.iniapiBillKey;
  if (!mid || !key) {
    throw new InicisBillingError(
      'NO_INICIS_CREDENTIALS',
      'INICIS_BILL_MID / INIAPI_BILL_KEY 가 설정되지 않았습니다.',
    );
  }

  const type = 'billing';
  const timestamp = dateTime14();
  const data = {
    url: config.inicis.siteUrl,
    moid: p.orderId,
    goodName: p.orderName,
    buyerName: p.buyerName ?? '',
    buyerEmail: p.buyerEmail ?? '',
    buyerTel: p.buyerTel ?? '',
    price: String(p.amount),
    billKey: p.billKey,
  };

  try {
    const res = await axios.post(
      config.inicis.billingApiUrl,
      {
        mid,
        type,
        paymethod: 'card',
        timestamp,
        clientIp: '127.0.0.1',
        data,
        hashData: iniapiHash(key, mid, type, timestamp, data),
      },
      {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        timeout: 15000,
      },
    );

    const body = (res.data ?? {}) as { resultCode?: string; resultMsg?: string; tid?: string; data?: { tid?: string } };
    if (body.resultCode !== '00') {
      throw new InicisBillingError(
        body.resultCode ?? 'INICIS_BILLING_FAILED',
        body.resultMsg ?? '이니시스 자동결제에 실패했습니다.',
      );
    }
    return {
      resultCode: body.resultCode,
      resultMsg: body.resultMsg ?? '',
      tid: body.tid ?? body.data?.tid ?? null,
      method: 'card',
    };
  } catch (err) {
    if (err instanceof InicisBillingError) throw err;
    const e = err as { response?: { data?: { resultCode?: string; resultMsg?: string } }; message?: string };
    const d = e.response?.data;
    throw new InicisBillingError(
      d?.resultCode ?? 'INICIS_BILLING_FAILED',
      d?.resultMsg ?? e.message ?? '이니시스 자동결제에 실패했습니다.',
    );
  }
}
