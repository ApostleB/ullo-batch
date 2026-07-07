import { AppDataSource } from '../db/data-source';
import { config } from '../config';
import { createJobLogger } from '../logger';

export const JOB_NAME = 'session-auto-complete';

type Log = ReturnType<typeof createJobLogger>;

/**
 * 수업 종료 자동 완료.
 * 수업 종료시각(scheduled_date + end_time)이 유예시간(GRACE) 이전인 BOOKED 세션을
 * COMPLETED로 전이하고 completed_at을 실제 수업 종료시각으로 채운다.
 * 파트너 수동 출석처리(BOOKED→COMPLETED/NO_SHOW) 누락분의 안전망 — 정산·리뷰가 COMPLETED에 의존한다.
 *
 * - BOOKED만 대상이라 재실행/중복 실행에 멱등(이미 COMPLETED/NO_SHOW/CANCELLED는 재선택 안 됨).
 * - completed_at은 배치 실행시각이 아니라 실제 수업 종료시각 — 리뷰 허용기간이 흔들리지 않게.
 * - 날짜 연산은 DB에서 수행(now()/make_interval)해 JS date 파싱의 KST off-by-one을 회피한다.
 *   (scheduled_date/end_time은 KST 벽시계 값 — DB 세션 타임존이 KST 기준이라는 전제.)
 */
export async function execute(log: Log): Promise<void> {
  const graceHours = config.params.sessionAutoCompleteGraceHours;
  const fromDate = config.params.sessionAutoCompleteFromDate; // 'YYYY-MM-DD' | null
  const dryRun = config.params.sessionAutoCompleteDryRun;

  // BOOKED + 삭제 안 됨 + 종료시각이 (now - grace) 이전 + (하한일 지정 시) 그 이후 수업만
  const whereSql = `
    mcs.session_status = 'BOOKED'
    AND COALESCE(mcs.is_del::text, 'N') = 'N'
    AND COALESCE(sch.is_del::text, 'N') <> 'Y'
    AND sch.end_time IS NOT NULL
    AND (sch.scheduled_date + sch.end_time) < (now() - ($1::int * interval '1 hour'))
    AND ($2::date IS NULL OR sch.scheduled_date >= $2::date)
  `;
  const params = [graceHours, fromDate];

  const countRows: Array<{ cnt: number }> = await AppDataSource.query(
    `SELECT COUNT(*)::int AS cnt
       FROM member_class_session mcs
       JOIN studio_class_schedule sch ON sch.class_schedule_id = mcs.class_schedule_id
      WHERE ${whereSql}`,
    params,
  );
  const targetCount = countRows[0]?.cnt ?? 0;
  const scope = fromDate ? `, ${fromDate} 이후` : '';
  log.info(`자동완료 대상(BOOKED, 종료+${graceHours}h 경과${scope}): ${targetCount}건`);
  if (targetCount === 0) return;

  if (dryRun) {
    log.warn(`DRY-RUN — 실제 전이 없이 종료 (대상 ${targetCount}건). 적용하려면 SESSION_AUTO_COMPLETE_DRY_RUN 해제.`);
    return;
  }

  const updated: Array<{ member_class_session_id: string }> = await AppDataSource.query(
    `UPDATE member_class_session mcs
        SET session_status = 'COMPLETED',
            completed_at = (sch.scheduled_date + sch.end_time)
       FROM studio_class_schedule sch
      WHERE sch.class_schedule_id = mcs.class_schedule_id
        AND ${whereSql}
      RETURNING mcs.member_class_session_id`,
    params,
  );

  log.info(`수업 종료 자동완료: 대상 ${targetCount}건 → COMPLETED ${updated.length}건`);
}
