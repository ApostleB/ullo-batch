import { randomUUID } from 'crypto';
import pRetry from 'p-retry';
import { AppDataSource } from '../db/data-source';
import { createJobLogger } from '../logger';

export interface JobRunner {
  name: string;
  retries?: number;
  execute: (log: ReturnType<typeof createJobLogger>) => Promise<void>;
}

/**
 * 잡 실행 래퍼.
 * - PG advisory lock 으로 중복 실행 방지 (단일 connection 유지 → 안전한 unlock)
 * - p-retry 재시도, 로깅
 */
export async function runJob({ name, execute, retries = 0 }: JobRunner): Promise<void> {
  const runId = randomUUID().slice(0, 8);
  const log = createJobLogger(name, runId);

  const runner = AppDataSource.createQueryRunner();
  await runner.connect();

  const locked: Array<{ ok: boolean }> = await runner.query(
    'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
    [name],
  );
  if (!locked[0]?.ok) {
    log.warn('이미 실행 중인 잡이 있어 스킵');
    await runner.release();
    return;
  }

  log.info('시작');
  const startedAt = Date.now();
  try {
    await pRetry(() => execute(log), {
      retries,
      onFailedAttempt: (err) => {
        log.warn(`재시도 ${err.attemptNumber}/${retries + 1} 실패: ${err.message}`);
      },
    });
    log.info(`완료 (${Date.now() - startedAt}ms)`);
  } catch (err) {
    log.error(`실패 (${Date.now() - startedAt}ms)`, {
      error: err instanceof Error ? err.message : String(err),
    });
    // 알림 채널(Slack 등) 연동 위치
  } finally {
    await runner.query('SELECT pg_advisory_unlock(hashtext($1))', [name]);
    await runner.release();
  }
}
