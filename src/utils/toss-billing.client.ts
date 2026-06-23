import axios from 'axios';
import { config } from '../config';

export interface TossBillingResult {
  paymentKey?: string;
  orderId?: string;
  status?: string;
  method?: string;
  totalAmount?: number;
  approvedAt?: string;
  lastTransactionKey?: string;
}

export class TossBillingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TossBillingError';
  }
}

function authHeader(): string {
  if (!config.toss.secretKey) {
    throw new TossBillingError('NO_SECRET_KEY', 'TOSS_SECRET_KEY 가 설정되지 않았습니다.');
  }
  return 'Basic ' + Buffer.from(`${config.toss.secretKey}:`).toString('base64');
}

export interface ChargeParams {
  billingKey: string;
  customerKey: string;
  amount: number;
  orderId: string;
  orderName: string;
}

/**
 * 빌링키 자동결제 — POST /v1/billing/{billingKey}
 * Idempotency-Key = orderId 로 중복 청구 방지.
 */
export async function chargeBilling(p: ChargeParams): Promise<TossBillingResult> {
  try {
    const res = await axios.post(
      `${config.toss.baseUrl}/v1/billing/${p.billingKey}`,
      {
        customerKey: p.customerKey,
        amount: p.amount,
        orderId: p.orderId,
        orderName: p.orderName,
      },
      {
        headers: {
          Authorization: authHeader(),
          'Content-Type': 'application/json',
          'Idempotency-Key': p.orderId,
        },
        timeout: 15000,
      },
    );
    return res.data as TossBillingResult;
  } catch (err) {
    if (err instanceof TossBillingError) throw err;
    const e = err as { response?: { data?: { code?: string; message?: string } }; message?: string };
    const data = e.response?.data;
    throw new TossBillingError(
      data?.code ?? 'TOSS_BILLING_FAILED',
      data?.message ?? e.message ?? '토스 자동결제에 실패했습니다.',
    );
  }
}
