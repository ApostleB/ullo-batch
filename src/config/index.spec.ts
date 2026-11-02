/**
 * config.danal — 배치 게이트는 정확히 'true' 일 때만 켜진다(기본 꺼짐).
 * dotenv 는 이미 설정된 process.env 를 덮어쓰지 않으므로, 값을 명시해서 로컬 .env 의 영향을 받지 않게 한다.
 */
describe('config.danal', () => {
  const KEYS = [
    'DANAL_BILLING_BATCH_ENABLED',
    'DANAL_SECRET_KEY',
    'DANAL_MERCHANT_ID',
    'DANAL_API_BASE_URL',
    'DANAL_BILLING_ABORT_RATIO',
    'DANAL_BILLING_ABORT_MIN_SAMPLE',
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  const load = () => {
    let cfg: typeof import('./index').config | undefined;
    jest.isolateModules(() => {
      cfg = require('./index').config;
    });
    return cfg!;
  };

  it("batchEnabled 는 정확히 'true' 일 때만 true", () => {
    process.env.DANAL_BILLING_BATCH_ENABLED = 'true';
    expect(load().danal.batchEnabled).toBe(true);
  });

  it.each(['false', 'TRUE', 'True', '1', 'yes', ' true', ''])("batchEnabled: '%s' 는 꺼짐", (v) => {
    process.env.DANAL_BILLING_BATCH_ENABLED = v;
    expect(load().danal.batchEnabled).toBe(false);
  });

  // [P-1] 한 잡에서 거절·비카드 오류 비율이 임계를 넘으면 잡을 중단한다 — 기본값 근거는 subscription-billing.job.ts 주석
  it('중단 임계 기본값: 비율 0.5, 최소 표본 5', () => {
    delete process.env.DANAL_BILLING_ABORT_RATIO;
    delete process.env.DANAL_BILLING_ABORT_MIN_SAMPLE;
    const c = load().danal;
    expect(c.billingAbortRatio).toBe(0.5);
    expect(c.billingAbortMinSample).toBe(5);
  });

  it('중단 임계는 환경변수로 바꿀 수 있다', () => {
    process.env.DANAL_BILLING_ABORT_RATIO = '0.3';
    process.env.DANAL_BILLING_ABORT_MIN_SAMPLE = '10';
    const c = load().danal;
    expect(c.billingAbortRatio).toBe(0.3);
    expect(c.billingAbortMinSample).toBe(10);
  });

  it.each(['abc', '', '0', '-1', '1.5'])("비율 '%s' 는 잘못된 값이라 기본값 0.5 (0 초과 1 이하만 인정 — 0 은 항상 중단이라 거부)", v => {
    process.env.DANAL_BILLING_ABORT_RATIO = v;
    expect(load().danal.billingAbortRatio).toBe(0.5);
  });

  it.each(['abc', '', '0', '-3', '2.5'])("최소 표본 '%s' 는 잘못된 값이라 기본값 5 (1 이상 정수만 인정)", v => {
    process.env.DANAL_BILLING_ABORT_MIN_SAMPLE = v;
    expect(load().danal.billingAbortMinSample).toBe(5);
  });

  it('환경변수 이름은 백엔드와 같고, API 기본 주소가 있다', () => {
    process.env.DANAL_SECRET_KEY = 'fake-secret';
    process.env.DANAL_MERCHANT_ID = 'fake-merchant';
    process.env.DANAL_API_BASE_URL = '';
    const c = load().danal;
    expect(c.secretKey).toBe('fake-secret');
    expect(c.merchantId).toBe('fake-merchant');
    expect(c.apiBaseUrl).toBe('https://one-api.danalpay.com');
  });
});

/** config.creditExpiry — 크레딧 만료 사전 안내 게이트는 정확히 'true' 일 때만 켜진다(기본 꺼짐) */
describe('config.creditExpiry', () => {
  const saved = process.env.CREDIT_EXPIRY_NOTICE_ENABLED;
  afterEach(() => {
    if (saved === undefined) delete process.env.CREDIT_EXPIRY_NOTICE_ENABLED;
    else process.env.CREDIT_EXPIRY_NOTICE_ENABLED = saved;
  });
  const load = () => {
    let cfg: typeof import('./index').config | undefined;
    jest.isolateModules(() => {
      cfg = require('./index').config;
    });
    return cfg!;
  };

  it.each([
    [undefined, false],
    ['', false],
    ['TRUE', false],
    ['1', false],
    ['true', true],
  ])('CREDIT_EXPIRY_NOTICE_ENABLED=%s → %s', (value, expected) => {
    if (value === undefined) delete process.env.CREDIT_EXPIRY_NOTICE_ENABLED;
    else process.env.CREDIT_EXPIRY_NOTICE_ENABLED = value;
    expect(load().creditExpiry.noticeEnabled).toBe(expected);
  });
});
