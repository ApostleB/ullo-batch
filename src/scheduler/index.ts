import schedule from 'node-schedule';
import { logger } from '../logger';
import { config } from '../config';
import { registerJob } from './common';
// import * as billing from '../jobs/subscription-billing.job';
import * as rolling from '../jobs/rolling-schedule.job';
import * as settlement from '../jobs/auto-settlement.job';
import * as healthCheck from '../jobs/health-check.job';

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

  //토스 결제 미사용으로 다음 정책이 나올떄까지 비활성화
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

  logger.info(`등록된 잡: ${jobs.length}개`);
}

export async function stopScheduler(): Promise<void> {
  logger.info('스케줄러 종료 중...');
  for (const job of jobs) job.cancel();
  await schedule.gracefulShutdown();
  logger.info('스케줄러 종료 완료');
}
