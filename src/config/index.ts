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
    // 매월 5일 04:00 — 1일이 아니라 5일. 월말 수업이 auto-complete grace(기본 24h)로 늦게 COMPLETED돼도
    // 정산 멱등 잠금 전에 집계되도록 여유를 둔다(월말 경계 정산 누락 방지). grace를 늘리면 이 날짜도 함께 뒤로.
    autoSettlement: { cron: process.env.JOB_AUTO_SETTLEMENT_CRON ?? '0 4 5 * *' },
    systemHealthCheck: { cron: process.env.JOB_HEALTH_CHECK ?? '* * * * *' },
    holiday: { cron: process.env.JOB_HOLIDAY_CRON ?? '0 2 1 * *' }, // 매월 1일 02:00
    memberPurge: { cron: process.env.JOB_MEMBER_PURGE_CRON ?? '0 5 * * *' }, // 매일 05:00
    sessionAutoComplete: { cron: process.env.JOB_SESSION_AUTO_COMPLETE_CRON ?? '30 2 * * *' }, // 매일 02:30 (정산 전)
    paymentReadyCleanup: { cron: process.env.JOB_PAYMENT_READY_CLEANUP_CRON ?? '0 1 * * *' }, // 매일 01:00
  },
  params: {
    rollingHorizonDays: num(process.env.ROLLING_HORIZON_DAYS, 30),
    settlementDefaultUnitPrice: num(process.env.SETTLEMENT_DEFAULT_UNIT_PRICE, 10000),
    settlementDefaultCommissionRate: num(process.env.SETTLEMENT_DEFAULT_COMMISSION_RATE, 0.1),
    holidayHorizonMonths: num(process.env.HOLIDAY_HORIZON_MONTHS, 3),
    // 수업 종료 후 유예시간(h) = 파트너의 NO_SHOW 마킹 마감시한(SLA).
    // 이 시간 내 미마킹분은 경과 후 COMPLETED로 확정된다 → 노쇼도 정산에 포함됨(정책: 기본 완료).
    // 노쇼를 정산에서 제외하려면 체크인/출석 데이터가 선행 필요(현재 미보유).
    sessionAutoCompleteGraceHours: num(process.env.SESSION_AUTO_COMPLETE_GRACE_HOURS, 24),
    // 미리보기 모드 — true면 대상 건수만 로깅하고 실제 UPDATE는 하지 않음(활성화 전 백로그 확인용).
    sessionAutoCompleteDryRun: (process.env.SESSION_AUTO_COMPLETE_DRY_RUN ?? '').trim().toLowerCase() === 'true',
    // 백필 하한일('YYYY-MM-DD') — 지정 시 이 날짜 이후 수업만 자동완료(과거 대량 소급 방지). 미지정이면 전체.
    sessionAutoCompleteFromDate: (process.env.SESSION_AUTO_COMPLETE_FROM_DATE ?? '').trim() || null,
    // 결제창 이탈 READY 주문: 요청 후 이 시간(h) 경과분을 ABORTED로 정리.
    paymentReadyAbortHours: num(process.env.PAYMENT_READY_ABORT_HOURS, 24),
  },
} as const;
