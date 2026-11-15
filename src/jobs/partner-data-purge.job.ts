import { config } from '../config';
import { AppDataSource } from '../db/data-source';
import { createJobLogger } from '../logger';
import { existingTables, StructuredQuery } from '../utils/table-exists.util';

export const JOB_NAME = 'partner-data-purge';

/** 한 번에 지우는 행 수 — 긴 잠금·큰 WAL 을 피하려고 나눠 지운다 */
export const BATCH_SIZE = 1000;

/** 한 실행에서 대상 하나당 최대 배치 수(1,000만 행). 넘으면 남은 행은 다음 실행에서 이어 지운다 — 무한 반복 방지 */
export const MAX_BATCHES_PER_TARGET = 10_000;

type Log = ReturnType<typeof createJobLogger>;

/** 보존 기간(DQ-5, 2026-11-13 사용자 결정) — 활동 로그 1년 · 알림 180일 · 비밀번호 재설정 기록 30일 */
export const SQL = {
  activityLog: `DELETE FROM partner_activity_log WHERE activity_log_id IN (
  SELECT activity_log_id FROM partner_activity_log
   WHERE created_at < now() - interval '1 year'
   ORDER BY created_at LIMIT $1)`,
  notificationIds: `SELECT partner_notification_id FROM partner_notification
 WHERE created_at < now() - interval '180 days'
 ORDER BY created_at LIMIT $1`,
  notificationRead: `DELETE FROM partner_notification_read WHERE partner_notification_id = ANY($1::uuid[])`,
  notification: `DELETE FROM partner_notification WHERE partner_notification_id = ANY($1::uuid[])`,
  passwordReset: `DELETE FROM partner_password_reset WHERE reset_id IN (
  SELECT reset_id FROM partner_password_reset
   WHERE created_at < now() - interval '30 days'
   ORDER BY created_at LIMIT $1)`,
} as const;

/** 단일 커넥션(QueryRunner) — structured result 로 삭제 건수를 받고, 알림 배치는 트랜잭션으로 묶는다 */
interface Runner extends StructuredQuery {
  startTransaction(): Promise<void>;
  commitTransaction(): Promise<void>;
  rollbackTransaction(): Promise<void>;
  release(): Promise<void>;
}

interface Target {
  label: string;
  tables: string[];
  /** 한 배치를 지운다 — deleted: 주 테이블 삭제 건수, child: 딸린 행(읽음) 삭제 건수, more: 다음 배치가 필요한가 */
  batch: (r: Runner) => Promise<BatchResult>;
}

interface BatchResult {
  deleted: number;
  child: number;
  more: boolean;
}

/** 단일 DELETE 배치 — 1,000행을 꽉 채워 지웠으면 남은 행이 있을 수 있다 */
async function simpleBatch(r: Runner, sql: string): Promise<BatchResult> {
  const deleted = (await r.query(sql, [BATCH_SIZE], true)).affected ?? 0;
  return { deleted, child: 0, more: deleted >= BATCH_SIZE };
}

const TARGETS: Target[] = [
  {
    label: '활동 로그(1년)',
    tables: ['partner_activity_log'],
    batch: (r) => simpleBatch(r, SQL.activityLog),
  },
  {
    label: '알림(180일)',
    tables: ['partner_notification', 'partner_notification_read'],
    // 같은 배치의 알림 ID 로 읽음 행을 먼저 지우고 알림을 지운다 — 한 트랜잭션이라 중간 실패 시 둘 다 롤백된다
    batch: async (r) => {
      await r.startTransaction();
      try {
        const sel = await r.query(SQL.notificationIds, [BATCH_SIZE], true);
        const ids = ((sel.records ?? []) as Array<{ partner_notification_id: string }>).map(
          (x) => x.partner_notification_id,
        );
        if (ids.length === 0) {
          await r.commitTransaction();
          return { deleted: 0, child: 0, more: false };
        }
        const child = (await r.query(SQL.notificationRead, [ids], true)).affected ?? 0;
        const deleted = (await r.query(SQL.notification, [ids], true)).affected ?? 0;
        await r.commitTransaction();
        // 다음 배치 여부는 고른 ID 수로 판단한다(동시 삭제로 deleted 가 줄어도 남은 행을 놓치지 않는다)
        return { deleted, child, more: ids.length >= BATCH_SIZE };
      } catch (err) {
        await r.rollbackTransaction();
        throw err;
      }
    },
  },
  {
    label: '비밀번호 재설정 기록(30일)',
    tables: ['partner_password_reset'],
    batch: (r) => simpleBatch(r, SQL.passwordReset),
  },
];

export const ALL_TABLES = [...new Set(TARGETS.flatMap((t) => t.tables))];

/**
 * 파트너 W10 데이터 보존 기간 파기 — 매일 04:30 (W10 설계 4-2절, W10f).
 *
 * 활동 로그·콘솔 알림(+읽음)·비밀번호 재설정 기록 중 보존 기간이 지난 행을 1,000행씩 반복 삭제한다(raw SQL, 엔티티 없음).
 * 날짜 비교는 DB 의 now()/interval 로 한다(JS 날짜 파싱 없음).
 *
 * - 게이트: PARTNER_DATA_PURGE_ENABLED 가 정확히 'true' 일 때만 조회·삭제한다(기본 꺼짐, CLI 수동 실행도 같다).
 * - 테이블이 없으면(W10 DDL 적용 전) 그 대상은 오류 로그만 남기고 건너뛴다. 예외를 던지지 않으므로 재시도·다른 잡에 영향이 없다.
 * - 배치마다 커밋하므로 중간에 실패해도 지운 행은 지워진 채로 남고, 재시도·다음 실행이 나머지를 이어 지운다(멱등).
 * - 로그에는 건수만 남긴다(회원·파트너 ID 없음).
 */
export async function execute(log: Log): Promise<void> {
  if (!config.partnerDataPurge.enabled) {
    log.info('PARTNER_DATA_PURGE_ENABLED 가 꺼져 있어 실행하지 않음');
    return;
  }

  const runner = AppDataSource.createQueryRunner() as unknown as Runner;
  try {
    const present = await existingTables(runner, ALL_TABLES);
    const results: string[] = [];

    for (const target of TARGETS) {
      const missing = target.tables.filter((t) => !present.has(t));
      if (missing.length > 0) {
        log.error(
          `[PARTNER_PURGE_TABLE_MISSING] ${target.label} 건너뜀 — 테이블 없음: ${missing.join(', ')} (W10 DDL 적용 확인)`,
        );
        results.push(`${target.label} 건너뜀`);
        continue;
      }

      let main = 0;
      let child = 0;
      let batches = 0;
      for (;;) {
        const res = await target.batch(runner);
        main += res.deleted;
        child += res.child;
        batches++;
        if (!res.more) break;
        if (batches >= MAX_BATCHES_PER_TARGET) {
          log.warn(`${target.label}: 한 실행 최대 ${MAX_BATCHES_PER_TARGET}배치에 도달 — 남은 행은 다음 실행에서 이어 지운다`);
          break;
        }
      }
      results.push(
        target.tables.length > 1 ? `${target.label} ${main}건(읽음 ${child}건)` : `${target.label} ${main}건`,
      );
    }

    log.info(`파트너 데이터 보존 기간 파기 완료: ${results.join(', ')}`);
  } finally {
    await runner.release();
  }
}
