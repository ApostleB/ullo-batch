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
// 수업 종료 자동완료 잡 — 아래 registerJob 주석 해제 시 이 import도 함께 활성화.
// import * as sessionAutoComplete from '../jobs/session-auto-complete.job';
// 결제창 이탈 READY 정리 잡 — 아래 registerJob 주석 해제 시 이 import도 함께 활성화.
// import * as paymentReadyCleanup from '../jobs/payment-ready-cleanup.job';

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

  // 수업 종료 자동 완료 — 매일 02:30 (종료+grace 경과 BOOKED → COMPLETED).
  // ⚠️ 최초 활성화 시 과거 미완료 BOOKED가 한꺼번에 COMPLETED로 소급되어 정산·리뷰에 반영된다.
  //   활성화 전 SESSION_AUTO_COMPLETE_DRY_RUN=true 로 `npm run job session-auto-complete` 실행해 대상 건수만 먼저 확인.
  //   백로그가 크면 SESSION_AUTO_COMPLETE_FROM_DATE='YYYY-MM-DD'로 하한일을 정한 뒤 아래 주석 해제.
  // registerJob(jobs, {
  //   name: sessionAutoComplete.JOB_NAME,
  //   cron: config.jobs.sessionAutoComplete.cron,
  //   retries: 1,
  //   execute: sessionAutoComplete.execute,
  // });

  // 결제창 이탈 READY 정리 — 매일 01:00 (요청 후 grace 경과 READY → ABORTED).
  // ⚠️ 활성화 전 확인: 오래된 READY가 비동기 승인(웹훅 등)으로 DONE 되는 경로가 없는지.
  //   있다면 PAYMENT_READY_ABORT_HOURS를 그 지연보다 길게. 먼저 `npm run job payment-ready-cleanup`로 대상 확인.
  // registerJob(jobs, {
  //   name: paymentReadyCleanup.JOB_NAME,
  //   cron: config.jobs.paymentReadyCleanup.cron,
  //   retries: 1,
  //   execute: paymentReadyCleanup.execute,
  // });

  logger.info(`등록된 잡: ${jobs.length}개`);
}

export async function stopScheduler(): Promise<void> {
  logger.info('스케줄러 종료 중...');
  for (const job of jobs) job.cancel();
  await schedule.gracefulShutdown();
  logger.info('스케줄러 종료 완료');
}
