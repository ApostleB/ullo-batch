import { AppDataSource } from '../db/data-source';
import { ScheduleStatus, SessionStatus } from '../entities/enums';
import { createJobLogger } from '../logger';

export const JOB_NAME = 'session-complete';

type Log = ReturnType<typeof createJobLogger>;

const CLASS_START = `(sch.scheduled_date + COALESCE(sch.start_time, TIME '00:00:00'))`;
const CLASS_END = `(sch.scheduled_date + COALESCE(sch.end_time, TIME '23:59:59'))`;

/**
 * 수업 종료 처리 — docs/session-finalize-design.md 의 확정 설계.
 *
 * A. 시작 처리: OPEN & 시작시각 경과 → STARTED
 * B. 종료 처리 (수업 단위 판정, 트랜잭션):
 *    - 컷오프 = 종료시각 (미체크인 BOOKED 멤버가 있으면 +1시간 유예)
 *    - 컷오프 경과 수업 → status COMPLETED (HOLD는 대상 제외 = PARTNER/ADMIN이 처리 중)
 *    - 해당 수업의 BOOKED 세션: 체크인 → COMPLETED / 미체크인 → NO_SHOW
 *    - 크레딧은 예약 시 이미 차감되므로 여기서는 건드리지 않는다 (이중 차감 방지)
 *
 * 시각 비교는 LOCALTIMESTAMP(DB 로컬시각) 기준 — date/time 컬럼과 동일한 wall-clock 기준.
 * AppDataSource.query()는 UPDATE에서 [rows, affected] 튜플을 반환하므로
 * QueryRunner + useStructuredResult(affected/records)로 집계한다.
 */
export async function execute(log: Log): Promise<void> {
  const runner = AppDataSource.createQueryRunner();
  await runner.connect();
  try {
    // A. 시작 처리 — OPEN & 시작시각 경과 → STARTED
    const started = await runner.query(
      `UPDATE studio_class_schedule AS sch
       SET status = $1, updated_at = now()
       WHERE sch.is_del = 'N' AND sch.status = $2
         AND ${CLASS_START} <= LOCALTIMESTAMP`,
      [ScheduleStatus.STARTED, ScheduleStatus.OPEN],
      true,
    );
    if ((started.affected ?? 0) > 0) {
      log.info(`수업 시작 처리: OPEN → STARTED ${started.affected}건`);
    }

    // B. 종료 처리 — 수업 클레임과 세션 확정을 원자적으로
    await runner.startTransaction();
    try {
      // B-1. 마감 대상 수업 클레임 (상태 조건을 UPDATE에 포함 → HOLD 전환과의 경합에도 안전)
      const claimed = await runner.query(
        `UPDATE studio_class_schedule AS sch
         SET status = $1, updated_at = now()
         WHERE sch.is_del = 'N' AND sch.status IN ($2, $3)
           AND ${CLASS_END}
               + (CASE WHEN EXISTS (
                    SELECT 1 FROM member_class_session s
                    WHERE s.class_schedule_id = sch.class_schedule_id
                      AND s.is_del = 'N' AND s.session_status = $4
                      AND s.checked_in_at IS NULL)
                  THEN INTERVAL '1 hour' ELSE INTERVAL '0' END)
               < LOCALTIMESTAMP
         RETURNING sch.class_schedule_id`,
        [ScheduleStatus.COMPLETED, ScheduleStatus.OPEN, ScheduleStatus.STARTED, SessionStatus.BOOKED],
        true,
      );
      const scheduleIds: string[] = (claimed.records ?? []).map(
        (r: { class_schedule_id: string }) => r.class_schedule_id,
      );

      if (scheduleIds.length > 0) {
        // B-2. 클레임된 수업의 BOOKED 세션 확정 — 체크인 → COMPLETED / 미체크인 → NO_SHOW
        const sessions = await runner.query(
          `UPDATE member_class_session AS s
           SET session_status = CASE WHEN s.checked_in_at IS NOT NULL THEN $1 ELSE $2 END,
               completed_at   = CASE WHEN s.checked_in_at IS NOT NULL THEN ${CLASS_END} ELSE NULL END,
               updated_at     = now()
           FROM studio_class_schedule AS sch
           WHERE sch.class_schedule_id = s.class_schedule_id
             AND s.class_schedule_id = ANY($3::uuid[])
             AND s.is_del = 'N' AND s.session_status = $4
           RETURNING s.session_status`,
          [SessionStatus.COMPLETED, SessionStatus.NO_SHOW, scheduleIds, SessionStatus.BOOKED],
          true,
        );
        const rows: Array<{ session_status: string }> = sessions.records ?? [];
        const completed = rows.filter((r) => r.session_status === SessionStatus.COMPLETED).length;
        const noShow = rows.length - completed;
        log.info(`수업 마감: ${scheduleIds.length}건 (세션 COMPLETED ${completed} / NO_SHOW ${noShow})`);
      } else {
        log.info('마감 대상 수업 없음');
      }

      await runner.commitTransaction();
    } catch (err) {
      await runner.rollbackTransaction();
      throw err;
    }
  } finally {
    await runner.release();
  }
}
