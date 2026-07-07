import { AppDataSource } from '../db/data-source';
import { config } from '../config';
import { createJobLogger } from '../logger';

export const JOB_NAME = 'payment-ready-cleanup';

type Log = ReturnType<typeof createJobLogger>;

/**
 * 결제창 이탈 READY 주문 정리.
 * 결제창을 열었다가 승인 전에 이탈하면 payment 행이 READY + payment_key(tid) NULL 로 남는다.
 * (admin pgStatus는 tid가 없어 이 건들을 PG 조회로 확정할 수 없다 → 배치로 만료 처리가 적합.)
 * requested_at 이 (now - ABORT_HOURS) 이전인 READY(tid 없음) 건을 ABORTED로 전이한다.
 *
 * - status='READY' + payment_key IS NULL 만 대상 → 승인된 적 없어 크레딧/구독상태 부수효과 없음.
 * - READY만 선택하므로 재실행에 멱등(이미 ABORTED/DONE은 재선택 안 됨).
 * - requested_at NULL 행은 aging 불가로 제외(안전 우선).
 * - 날짜 연산은 DB에서 수행(now()/interval) — JS date 파싱 회피. (DB 세션 tz가 저장 시각과 동일 기준 전제.)
 */
export async function execute(log: Log): Promise<void> {
  const abortHours = config.params.paymentReadyAbortHours;

  const whereSql = `
    status = 'READY'
    AND payment_key IS NULL
    AND requested_at IS NOT NULL
    AND requested_at < (now() - ($1::int * interval '1 hour'))
  `;

  const countRows: Array<{ cnt: number }> = await AppDataSource.query(
    `SELECT COUNT(*)::int AS cnt FROM payment WHERE ${whereSql}`,
    [abortHours],
  );
  const targetCount = countRows[0]?.cnt ?? 0;
  log.info(`READY 정리 대상(요청 후 ${abortHours}h 경과, tid 없음): ${targetCount}건`);
  if (targetCount === 0) return;

  const updated: Array<{ payment_id: string }> = await AppDataSource.query(
    `UPDATE payment
        SET status = 'ABORTED',
            fail_code = COALESCE(fail_code, 'READY_TIMEOUT'),
            fail_reason = COALESCE(fail_reason, '결제창 이탈 자동 정리(승인 전 READY 만료)'),
            updated_at = now()
      WHERE ${whereSql}
      RETURNING payment_id`,
    [abortHours],
  );

  log.info(`결제창 이탈 READY 정리: 대상 ${targetCount}건 → ABORTED ${updated.length}건`);
}
