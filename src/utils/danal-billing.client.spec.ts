import axios from 'axios';

// 테스트 값은 전부 가짜다. 실제 다날 호출은 하지 않는다.
const mockConfig = {
  danal: {
    secretKey: 'fake-secret',
    merchantId: 'fake-merchant',
    apiBaseUrl: 'https://danal.test/',
    batchEnabled: true,
  },
};
jest.mock('../config', () => ({ config: mockConfig }));
jest.mock('axios');

import { cancel, classifyDanalFailure, confirmBilling, DanalApiError, DanalResultUnknownError } from './danal-billing.client';

const post = axios.post as jest.Mock;
const input = {
  billingKey: 'fake-billing-key',
  userId: 'member-1',
  amount: 9900,
  orderName: '구독 플랜',
  orderId: 'sub_p1_202611_1',
};

beforeEach(() => {
  post.mockReset();
  mockConfig.danal.secretKey = 'fake-secret';
  mockConfig.danal.merchantId = 'fake-merchant';
  mockConfig.danal.apiBaseUrl = 'https://danal.test/';
});

describe('danal-billing.client — confirmBilling', () => {
  it('POST {base}/billing/confirm 에 Basic 인증·15초 타임아웃으로 요청한다', async () => {
    post.mockResolvedValue({ status: 200, data: { code: 'SUCCESS', transactionId: 'tx-1', orderId: input.orderId, amount: 9900 } });

    await confirmBilling(input);

    const [url, body, opts] = post.mock.calls[0];
    expect(url).toBe('https://danal.test/billing/confirm');
    expect(body).toEqual({
      method: 'CARD',
      billingKey: 'fake-billing-key',
      userId: 'member-1',
      amount: 9900,
      orderName: '구독 플랜',
      merchantId: 'fake-merchant',
      orderId: input.orderId,
    });
    expect(opts.headers.Authorization).toBe(`Basic ${Buffer.from('fake-secret:').toString('base64')}`);
    expect(opts.timeout).toBe(15000);
    expect(opts.validateStatus()).toBe(true);
  });

  it('orderName 은 80바이트 안으로 자른다', async () => {
    post.mockResolvedValue({ status: 200, data: { code: 'SUCCESS' } });
    await confirmBilling({ ...input, orderName: '가'.repeat(60) });
    expect(Buffer.byteLength(post.mock.calls[0][1].orderName)).toBeLessThanOrEqual(80);
  });

  it('응답 amount 가 문자열이어도 숫자로 바꾼다', async () => {
    post.mockResolvedValue({ status: 200, data: { code: 'SUCCESS', transactionId: 'tx-1', orderId: input.orderId, amount: '9900' } });
    await expect(confirmBilling(input)).resolves.toEqual({ transactionId: 'tx-1', orderId: input.orderId, amount: 9900 });
  });

  it('응답에 필드가 없으면 null 로 돌려준다(호출 측이 fail-closed 로 대조)', async () => {
    post.mockResolvedValue({ status: 200, data: { code: 'SUCCESS' } });
    await expect(confirmBilling(input)).resolves.toEqual({ transactionId: null, orderId: null, amount: null });
  });

  it('code 가 있고 SUCCESS 가 아니면 DanalApiError', async () => {
    post.mockResolvedValue({ status: 400, data: { code: 'CARD_LIMIT', message: '한도 초과' } });
    const err = await confirmBilling(input).catch((e) => e);
    expect(err).toBeInstanceOf(DanalApiError);
    expect(err.code).toBe('CARD_LIMIT');
  });

  it('5xx 는 code 가 있어도 결과 불명', async () => {
    post.mockResolvedValue({ status: 502, data: { code: 'SOMETHING', message: 'x' } });
    await expect(confirmBilling(input)).rejects.toBeInstanceOf(DanalResultUnknownError);
  });

  it('code 없는 응답(형식 오류)은 결과 불명', async () => {
    post.mockResolvedValue({ status: 200, data: '<html>' });
    await expect(confirmBilling(input)).rejects.toBeInstanceOf(DanalResultUnknownError);
  });

  it('타임아웃·연결 오류는 결과 불명이며 메시지에 비밀키·빌링키가 없다', async () => {
    post.mockRejectedValue(
      Object.assign(new Error('timeout of 15000ms exceeded fake-secret fake-billing-key'), { code: 'ECONNABORTED' }),
    );
    const err = await confirmBilling(input).catch((e) => e);
    expect(err).toBeInstanceOf(DanalResultUnknownError);
    expect(err.message).toContain('ECONNABORTED');
    expect(err.message).not.toContain('fake-secret');
    expect(err.message).not.toContain('fake-billing-key');
  });

  it('설정이 없으면 다날 호출 없이 오류', async () => {
    mockConfig.danal.secretKey = '';
    await expect(confirmBilling(input)).rejects.toThrow('DANAL_SECRET_KEY');
    mockConfig.danal.secretKey = 'fake-secret';
    mockConfig.danal.merchantId = '';
    await expect(confirmBilling(input)).rejects.toThrow('DANAL_MERCHANT_ID');
    expect(post).not.toHaveBeenCalled();
  });
});

// [P-1] 백엔드 src/payment/danal.client.spec.ts 의 분류 표와 같다(복제) — 한쪽을 바꾸면 함께 바꾼다.
describe('danal-billing.client — DanalApiError 분류 (P-1)', () => {
  it.each([401, 403, 404, 408, 422, 429, 400])('HTTP %i 응답은 code 가 있어도 카드 거절이 아니다', async (status) => {
    post.mockResolvedValue({ status, data: { code: 'E100', message: 'x' } });
    const err = await confirmBilling(input).catch((e) => e);
    expect(err).toBeInstanceOf(DanalApiError);
    expect(err.httpStatus).toBe(status);
    expect(err.isCardDecline).toBe(false);
  });

  it('HTTP 200 + 비SUCCESS 일반 코드는 카드 거절 (httpStatus 보존)', async () => {
    post.mockResolvedValue({ status: 200, data: { code: 'E300', message: '한도 초과' } });
    const err = await confirmBilling(input).catch((e) => e);
    expect(err.httpStatus).toBe(200);
    expect(err.isCardDecline).toBe(true);
  });

  it.each(['UNAUTHORIZED', 'INVALID_SECRET_KEY', 'MERCHANT_NOT_FOUND', 'CONTRACT_EXPIRED', 'FORBIDDEN_IP', 'TOO_MANY_REQUESTS', 'INVALID_PARAMETER'])(
    'HTTP 200 이어도 가맹점·인증·계약 오류로 보이는 코드(%s)는 카드 거절이 아니다',
    async (code) => {
      post.mockResolvedValue({ status: 200, data: { code, message: 'x' } });
      const err = await confirmBilling(input).catch((e) => e);
      expect(err.isCardDecline).toBe(false);
    },
  );

  it('cancel 도 같은 분류를 갖는다', async () => {
    post.mockResolvedValue({ status: 401, data: { code: 'E1', message: 'x' } });
    const err = await cancel({ transactionId: 't', amount: 1, cancelType: 'C' }).catch((e) => e);
    expect(err.httpStatus).toBe(401);
  });

  it('classifyDanalFailure 표', () => {
    expect(classifyDanalFailure(401, 'CARD_DECLINED')).toBe('NON_CARD');
    expect(classifyDanalFailure(200, 'CARD_DECLINED')).toBe('CARD_DECLINED');
    expect(classifyDanalFailure(200, 'api_key_invalid')).toBe('NON_CARD');
    expect(classifyDanalFailure(200, '한도초과')).toBe('CARD_DECLINED');
    expect(new DanalApiError('E1', 'x').httpStatus).toBe(200);
  });
});

describe('danal-billing.client — cancel', () => {
  it('POST /payments/cancel (method CARD, cancelType C)', async () => {
    post.mockResolvedValue({ status: 200, data: { code: 'SUCCESS', transactionId: 'cancel-tx' } });

    const res = await cancel({ transactionId: 'tx-1', amount: 9900, cancelType: 'C', cancelReason: '자동취소' });

    expect(res).toEqual({ transactionId: 'cancel-tx' });
    const [url, body] = post.mock.calls[0];
    expect(url).toBe('https://danal.test/payments/cancel');
    expect(body).toEqual({
      method: 'CARD',
      transactionId: 'tx-1',
      merchantId: 'fake-merchant',
      amount: 9900,
      cancelType: 'C',
      cancelReason: '자동취소',
    });
  });

  it('실패 code 는 DanalApiError', async () => {
    post.mockResolvedValue({ status: 400, data: { code: 'ALREADY_CANCELED', message: 'x' } });
    await expect(cancel({ transactionId: 'tx-1', amount: 1000, cancelType: 'C' })).rejects.toBeInstanceOf(DanalApiError);
  });
});
