import 'reflect-metadata';
import { AppDataSource } from './db/data-source';
import { logger } from './logger';
import { startScheduler, stopScheduler } from './scheduler';
import { readBuildInfo } from './build-info';

async function main(): Promise<void> {
  // 배치는 HTTP 가 없어 배포된 커밋을 물어볼 곳이 없다. 기동 로그가 유일한 기록이다.
  const build = readBuildInfo();
  logger.info('ullo-batch 서비스 시작', { commit: build.commit, ref: build.ref, built_at: build.built_at });
  await AppDataSource.initialize();
  logger.info('DB 연결 완료');

  startScheduler();

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function shutdown(): Promise<void> {
  logger.info('종료 신호 수신');
  await stopScheduler();
  if (AppDataSource.isInitialized) await AppDataSource.destroy();
  logger.info('DB 연결 해제');
  process.exit(0);
}

main().catch((err) => {
  logger.error('서비스 시작 실패', { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
