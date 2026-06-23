import schedule from 'node-schedule';
import { runJob } from '../utils/run-job';
import { createJobLogger } from '../logger';

export interface JobDefinition {
  name: string;
  cron: string;
  retries?: number;
  execute: (log: ReturnType<typeof createJobLogger>) => Promise<void>;
}

export function registerJob(registry: schedule.Job[], job: JobDefinition): void {
  const scheduled = schedule.scheduleJob(job.cron, () => {
    void runJob({ name: job.name, retries: job.retries ?? 0, execute: job.execute });
  });
  if (scheduled) registry.push(scheduled);
}
