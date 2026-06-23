import {createJobLogger} from "../logger";

export const JOB_NAME = 'system-health-check';

type Log = ReturnType<typeof createJobLogger>;

export async function executeHealthCheck(log: Log): Promise<void>  {
  const now = new Date();

  log.info(`BATCH 헬스 체크 ${now}`);
}
