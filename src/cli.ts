import 'reflect-metadata';
import { AppDataSource } from './db/data-source';
import { logger } from './logger';
import { runJob } from './utils/run-job';
import { createJobLogger } from './logger';
import * as billing from './jobs/subscription-billing.job';
import * as rolling from './jobs/rolling-schedule.job';
import * as settlement from './jobs/auto-settlement.job';

type Exec = (log: ReturnType<typeof createJobLogger>) => Promise<void>;

const registry: Record<string, { name: string; execute: Exec }> = {
  billing: { name: billing.PRIMARY_JOB_NAME, execute: billing.executePrimary },
  'billing-retry': { name: billing.RETRY_JOB_NAME, execute: billing.executeRetry },
  rolling: { name: rolling.JOB_NAME, execute: rolling.execute },
  settlement: { name: settlement.JOB_NAME, execute: settlement.execute },
};

async function main(): Promise<void> {
  const key = process.argv[2];
  const job = registry[key];
  if (!job) {
    logger.error(`사용법: npm run job <${Object.keys(registry).join(' | ')}>`);
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
