import dotenv from 'dotenv';

dotenv.config();

function num(v: string | undefined, def: number): number {
  // Number('') / Number(' ') 는 0(finite)을 반환하므로, 값이 비어 있으면 기본값으로 처리한다.
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  env: process.env.NODE_ENV ?? 'local',
  // 원본 NODE_ENV — 미주입이면 undefined. 운영 판단(isExplicitNonProduction)은 기본값 'local' 에 속지 않도록 이 값을 쓴다.
  nodeEnv: process.env.NODE_ENV,
  db: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: num(process.env.DB_PORT, 5432),
    database: process.env.DB_NAME ?? 'ullo',
    username: process.env.DB_USERNAME ?? 'ullo',
    password: process.env.DB_PASSWORD ?? '',
  },
  toss: {
    secretKey: process.env.TOSS_SECRET_KEY ?? '',
    baseUrl: 'https://api.tosspayments.com',
  },
  danal: {
    // 다날 ONE API 서버 호출 — 백엔드와 같은 환경변수 이름. 값은 .env 로만 주입한다.
    secretKey: process.env.DANAL_SECRET_KEY ?? '',
    merchantId: process.env.DANAL_MERCHANT_ID ?? '',
    apiBaseUrl: process.env.DANAL_API_BASE_URL || 'https://one-api.danalpay.com',
    // 월 자동결제 배치 게이트 — 정확히 'true' 일 때만 청구한다(기본 꺼짐)
    batchEnabled: process.env.DANAL_BILLING_BATCH_ENABLED === 'true',
  },
  inicis: {
    // 빌링(구독) MID 의 자격 — 일반결제(INICIS_MID/INIAPI_KEY)와 다르다 (테스트: INIBillTst)
    billMid: process.env.INICIS_BILL_MID ?? '',
    iniapiBillKey: process.env.INIAPI_BILL_KEY ?? '',
    siteUrl: process.env.INICIS_SITE_URL || 'https://ullo.co.kr',
  },
  billing: {
    // member_billing.billing_key 복호화 키 — 백엔드 BILLING_KEY_ENC_KEY 와 동일해야 한다
    encKey: process.env.BILLING_KEY_ENC_KEY ?? '',
  },
  openApi: {
    // 공공데이터포털 서비스키 (디코딩된 값)
    serviceKey: process.env.PUBLIC_DATA_API_KEY ?? '',
    baseUrl: 'http://apis.data.go.kr',
  },
  log: {
    level: process.env.LOG_LEVEL ?? 'info',
    dir: process.env.LOG_DIR ?? 'logs',
  },
  jobs: {
    billing: { cron: process.env.JOB_BILLING_CRON ?? '0 21 * * *' },
    billingRetry: { cron: process.env.JOB_BILLING_RETRY_CRON ?? '0 20 * * *' },
    rollingSchedule: { cron: process.env.JOB_ROLLING_SCHEDULE_CRON ?? '0 3 * * *' },
    autoSettlement: { cron: process.env.JOB_AUTO_SETTLEMENT_CRON ?? '0 4 1 * *' },
    systemHealthCheck: { cron: process.env.JOB_HEALTH_CHECK ?? '* * * * *' },
    holiday: { cron: process.env.JOB_HOLIDAY_CRON ?? '0 2 1 * *' }, // 매월 1일 02:00
    memberPurge: { cron: process.env.JOB_MEMBER_PURGE_CRON ?? '0 5 * * *' }, // 매일 05:00
    sessionComplete: { cron: process.env.JOB_SESSION_COMPLETE_CRON ?? '*/10 * * * *' }, // 10분마다
  },
  params: {
    rollingHorizonDays: num(process.env.ROLLING_HORIZON_DAYS, 30),
    settlementDefaultUnitPrice: num(process.env.SETTLEMENT_DEFAULT_UNIT_PRICE, 10000),
    settlementDefaultCommissionRate: num(process.env.SETTLEMENT_DEFAULT_COMMISSION_RATE, 0.1),
    holidayHorizonMonths: num(process.env.HOLIDAY_HORIZON_MONTHS, 3),
  },
} as const;
