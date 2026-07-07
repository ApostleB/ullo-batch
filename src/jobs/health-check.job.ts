import { AppDataSource } from '../db/data-source';
import { createJobLogger } from '../logger';

export const JOB_NAME = 'system-health-check';

type Log = ReturnType<typeof createJobLogger>;

/**
 * 매분 실행되는 헬스 체크.
 * 프로세스 생존은 로그 라인 자체로 확인되고, DB 연결 생존은 SELECT 1 핑으로 검증한다.
 * (기존 구현은 잡 자신의 cron 문자열만 찍어 실제 헬스 정보가 없었음)
 */
export async function executeHealthCheck(log: Log): Promise<void> {
  const startedAt = Date.now();
  let dbOk = false;
  try {
    await AppDataSource.query('SELECT 1');
    dbOk = true;
  } catch (err) {
    log.error('헬스 체크 DB 핑 실패', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const uptimeSec = Math.round(process.uptime());
  log.info(`헬스 체크 db=${dbOk ? 'OK' : 'FAIL'} uptime=${uptimeSec}s (${Date.now() - startedAt}ms)`);
}
