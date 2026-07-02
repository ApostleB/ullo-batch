import schedule from 'node-schedule';
import { runJob } from '../utils/run-job';
import { createJobLogger, logger } from '../logger';

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
  // node-schedule은 cron 표현식이 유효하지 않으면 null을 반환한다.
  // 조용히 누락되면 정산·결제 잡이 등록조차 안 된 채 넘어가므로 명시적으로 에러를 노출한다.
  if (!scheduled) {
    throw new Error(`잡 등록 실패: '${job.name}' 의 cron 표현식이 유효하지 않습니다 ("${job.cron}")`);
  }
  registry.push(scheduled);
  logger.info(`잡 등록: ${job.name} (cron: ${job.cron})`);
}
