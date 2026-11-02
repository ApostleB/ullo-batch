import schedule from 'node-schedule';
import { logger } from '../logger';
import { config } from '../config';
import { registerJob } from './common';
// import * as billing from '../jobs/subscription-billing.job';
import * as rolling from '../jobs/rolling-schedule.job';
import * as settlement from '../jobs/auto-settlement.job';
import * as healthCheck from '../jobs/health-check.job';
import * as holiday from '../jobs/holiday.job';
import * as memberPurge from '../jobs/member-purge.job';
import * as sessionComplete from '../jobs/session-complete.job';
// import * as creditExpiryNotice from '../jobs/credit-expiry-notice.job';

const jobs: schedule.Job[] = [];

export function startScheduler(): void {
  logger.info('스케줄러 시작');

  //스케쥴러 헬스 체크
  registerJob(jobs, {
    name: healthCheck.JOB_NAME,
    cron: config.jobs.systemHealthCheck.cron,
    retries: 0,
    execute: healthCheck.executeHealthCheck
  })

  // ── 구독 정기결제(subscription-billing) — 미사용으로 잡 등록 비활성화 ──
  // 정기구독 기능을 쓰지 않기로 해서 스케줄 등록하지 않는다(자동 청구 없음).
  // 이니시스 전환 코드(subscription-billing.job / inipay-billing.client)는 그대로 두어
  // 정책이 정해지면 아래 주석만 해제하면 되도록 한다. CLI 수동 실행은 여전히 가능:
  //   npm run job billing / npm run job billing-retry
  // 구독 정기결제 — 매일 21:00 (재시도는 매일 20:00). 잡 내부에서 건별 처리하므로 p-retry는 0.
  // registerJob(jobs, {
  //   name: billing.PRIMARY_JOB_NAME,
  //   cron: config.jobs.billing.cron,
  //   retries: 0,
  //   execute: billing.executePrimary,
  // });
  // registerJob(jobs, {
  //   name: billing.RETRY_JOB_NAME,
  //   cron: config.jobs.billingRetry.cron,
  //   retries: 0,
  //   execute: billing.executeRetry,
  // });

  // 반복 스케줄 롤링 — 매일 03:00
  registerJob(jobs, {
    name: rolling.JOB_NAME,
    cron: config.jobs.rollingSchedule.cron,
    retries: 2,
    execute: rolling.execute,
  });

  // 정산 자동 생성 — 매월 1일 04:00
  registerJob(jobs, {
    name: settlement.JOB_NAME,
    cron: config.jobs.autoSettlement.cron,
    retries: 2,
    execute: settlement.execute,
  });

  // 공휴일 동기화 — 매월 1일 02:00 (미래 3개월치 upsert)
  registerJob(jobs, {
    name: holiday.JOB_NAME,
    cron: config.jobs.holiday.cron,
    retries: 3,
    execute: holiday.execute,
  });

  // 탈퇴 회원 분리보관 개인정보 파기 — 매일 05:00 (purge_at 경과분)
  registerJob(jobs, {
    name: memberPurge.JOB_NAME,
    cron: config.jobs.memberPurge.cron,
    retries: 1,
    execute: memberPurge.execute,
  });

  // 수업 종료 처리 — 10분마다 (종료 시각 지난 BOOKED 세션 → COMPLETED)
  registerJob(jobs, {
    name: sessionComplete.JOB_NAME,
    cron: config.jobs.sessionComplete.cron,
    retries: 1,
    execute: sessionComplete.execute,
  });

  // ── 크레딧 만료 15일 전 사전 안내(credit-expiry-notice) — 스케줄 등록 비활성화(billing 잡과 같은 관례) ──
  // 운영 게이트(CREDIT_EXPIRY_NOTICE_ENABLED=true)를 켜고 정책 확인 뒤 아래 주석을 해제한다. CLI 수동 실행은 가능:
  //   npm run job credit-expiry-notice   (재현: -- --as-of YYYY-MM-DD --member <id>, billing 과 같은 안전장치)
  // 매일 10:00. 잡 내부에서 회원·만료일 묶음 단위로 멱등 처리하므로 p-retry 는 0.
  // registerJob(jobs, {
  //   name: creditExpiryNotice.JOB_NAME,
  //   cron: config.jobs.creditExpiryNotice.cron,
  //   retries: 0,
  //   execute: creditExpiryNotice.execute,
  // });

  logger.info(`등록된 잡: ${jobs.length}개`);
}

export async function stopScheduler(): Promise<void> {
  logger.info('스케줄러 종료 중...');
  for (const job of jobs) job.cancel();
  await schedule.gracefulShutdown();
  logger.info('스케줄러 종료 완료');
}
