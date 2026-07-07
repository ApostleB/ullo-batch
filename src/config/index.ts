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
  inicis: {
    // KG이니시스 빌링(자동결제) — 빌링 MID + INIAPI 2.0 빌링 key (ullo inipay.client.ts와 동일 자격증명)
    billMid: process.env.INICIS_BILL_MID ?? '',
    iniapiBillKey: process.env.INIAPI_BILL_KEY ?? '',
    siteUrl: process.env.INICIS_SITE_URL ?? 'https://ullo.co.kr',
    billingApiUrl: 'https://iniapi.inicis.com/v2/pg/billing',
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
  },
  params: {
    rollingHorizonDays: num(process.env.ROLLING_HORIZON_DAYS, 30),
    settlementDefaultUnitPrice: num(process.env.SETTLEMENT_DEFAULT_UNIT_PRICE, 10000),
    settlementDefaultCommissionRate: num(process.env.SETTLEMENT_DEFAULT_COMMISSION_RATE, 0.1),
    holidayHorizonMonths: num(process.env.HOLIDAY_HORIZON_MONTHS, 3),
  },
} as const;
