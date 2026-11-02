import 'reflect-metadata';
import { AppDataSource } from './db/data-source';
import { logger } from './logger';
import { runJob } from './utils/run-job';
import { createJobLogger } from './logger';
import { parseTestOptions, setTestOptions } from './utils/test-options';
import * as billing from './jobs/subscription-billing.job';
import * as rolling from './jobs/rolling-schedule.job';
import * as settlement from './jobs/auto-settlement.job';
import * as holiday from './jobs/holiday.job';
import * as memberPurge from './jobs/member-purge.job';
import * as sessionComplete from './jobs/session-complete.job';
import * as creditExpiryNotice from './jobs/credit-expiry-notice.job';

type Exec = (log: ReturnType<typeof createJobLogger>) => Promise<void>;

const registry: Record<string, { name: string; execute: Exec }> = {
  billing: { name: billing.PRIMARY_JOB_NAME, execute: billing.executePrimary },
  'billing-retry': { name: billing.RETRY_JOB_NAME, execute: billing.executeRetry },
  rolling: { name: rolling.JOB_NAME, execute: rolling.execute },
  settlement: { name: settlement.JOB_NAME, execute: settlement.execute },
  holiday: { name: holiday.JOB_NAME, execute: holiday.execute },
  'member-purge': { name: memberPurge.JOB_NAME, execute: memberPurge.execute },
  'session-complete': { name: sessionComplete.JOB_NAME, execute: sessionComplete.execute },
  'credit-expiry-notice': { name: creditExpiryNotice.JOB_NAME, execute: creditExpiryNotice.execute },
};

async function main(): Promise<void> {
  const key = process.argv[2];
  const job = registry[key];
  if (!job) {
    logger.error(`사용법: npm run job <${Object.keys(registry).join(' | ')}>`);
    process.exit(1);
  }

  // 재현 테스트 옵션(--as-of/--member) — billing·billing-retry·credit-expiry-notice 잡 한정, 알 수 없는 옵션·운영·비로컬 다날 URL·DB 미확인이면 DB 연결 전에 거부한다. 스케줄러(index.ts)는 쓰지 않는다.
  try {
    setTestOptions(parseTestOptions(key, process.argv.slice(3), process.env));
  } catch (err) {
    logger.error(`테스트 옵션 거부: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  await AppDataSource.initialize();
  logger.info(`[수동 실행] ${key}`);
  await runJob({ name: job.name, retries: 0, execute: job.execute });
  await AppDataSource.destroy();
  process.exit(0);
}

main().catch((err) => {
  logger.error('수동 실행 실패', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
