import { AppDataSource } from '../db/data-source';
import { config } from '../config';
import { addDays, formatLocalDateTime, today, ymd } from '../utils/date.util';
import { getTestMemberId } from '../utils/test-options';
import { createJobLogger } from '../logger';
import { buildCreditExpiryMessage, creditExpiryLink, daysBetween } from '../utils/credit-expiry-notice.util';
import { recordKakaoStubNotice } from '../utils/subscription-cancel-notice.util';

export const JOB_NAME = 'credit-expiry-notice';
/** 만료 며칠 전에 안내하는가 */
export const NOTICE_DAYS_BEFORE = 15;

type Log = ReturnType<typeof createJobLogger>;

interface Candidate {
  member_id: string;
  end_dt: string;
  remaining: number | string;
}

/**
 * 대상 = 해지된 구독(CANCELED)에서 지급된 크레딧(credit_type='SUBSCRIPTION', member_membership_id = member_plan_id) 중
 * 잔여가 있고 만료일이 [오늘 + 1일, 오늘 + 15일] 인 lot 을 회원·만료일 묶음으로 합산한 것. 날짜는 to_char 로 'YYYY-MM-DD' 문자열을 받는다.
 * - 평소(매일 실행)에는 만료일이 정확히 오늘 + 15일인 묶음만 새로 걸린다(나머지는 이미 안내해 건너뛴다).
 * - 배치가 못 돈 날 D-15 를 지나쳤어도 D-14 ~ D-1 사이에서 아직 안내하지 않은 묶음을 1회 안내한다.
 * - 구독이 활성이거나 쿠폰·일회성 크레딧, 탈퇴 회원, 잔여 0 인 lot 은 대상이 아니다.
 * - 활성 정지 회원은 대상이 아니다(로그인할 수 없어 "만료 전에 이용" 안내가 의미 없다). 조건은 백엔드 MemberSuspensionHelper 와 같다:
 *   released_at IS NULL AND (end_at IS NULL OR end_at > 지금). 지금 = 로컬 시각 문자열($3, --member 가 있으면 $4).
 */
const CANDIDATE_SQL = (memberScoped: boolean) => `
  SELECT mc.member_id AS member_id,
         to_char(mc.end_dt, 'YYYY-MM-DD') AS end_dt,
         SUM(mc.credit) AS remaining
    FROM member_credit mc
    JOIN member_plan mp ON mp.member_plan_id = mc.member_membership_id
    JOIN member m ON m.member_id = mc.member_id
   WHERE mc.credit_type = 'SUBSCRIPTION'
     AND mc.is_del = 'N'
     AND mc.credit > 0
     AND mp.status = 'CANCELED'
     AND mp.is_del = 'N'
     AND m.is_del = 'N'
     AND mc.end_dt >= $1::date
     AND mc.end_dt <= $2::date
     AND NOT EXISTS (
       SELECT 1 FROM member_suspension ms
        WHERE ms.member_id = mc.member_id AND ms.released_at IS NULL AND (ms.end_at IS NULL OR ms.end_at > ${memberScoped ? '$4' : '$3'})
     )
     ${memberScoped ? 'AND mc.member_id = $3' : ''}
   GROUP BY mc.member_id, mc.end_dt
   ORDER BY mc.member_id, mc.end_dt`;

type Result = 'sent' | 'skipped' | 'failed';

/** 한 묶음 안내 — 같은 회원·만료일 락 아래에서 "이미 안내했는가"를 확인하고 기록한다(동시 실행·재실행에도 1회) */
async function noticeOne(c: Candidate, base: string, log: Log): Promise<Result> {
  const remaining = Number(c.remaining);
  const link = creditExpiryLink(c.end_dt);
  return AppDataSource.transaction(async (m): Promise<Result> => {
    await m.query(`SELECT pg_advisory_xact_lock(hashtext('creditexp:' || $1 || ':' || $2))`, [c.member_id, c.end_dt]);
    const done: unknown[] = await m.query(
      `SELECT 1 AS one FROM member_notification WHERE member_id = $1 AND category = 'KAKAO_STUB' AND link = $2 LIMIT 1`,
      [c.member_id, link],
    );
    if (done.length > 0) return 'skipped';
    const message = buildCreditExpiryMessage({ remaining, endYmd: c.end_dt, daysLeft: daysBetween(base, c.end_dt) });
    const ok = await recordKakaoStubNotice(m, { memberId: c.member_id, title: message.title, body: message.body, link }, log);
    return ok ? 'sent' : 'failed';
  });
}

/** 매일 — 해지된 구독의 크레딧 만료 15일 전 사전 안내(카카오 스텁: 실제 발송 없이 member_notification 에 기록만) */
export async function execute(log: Log): Promise<void> {
  if (!config.creditExpiry.noticeEnabled) {
    log.info('CREDIT_EXPIRY_NOTICE_ENABLED 가 켜져 있지 않아 크레딧 만료 안내를 실행하지 않습니다.');
    return;
  }
  const base = today();
  const baseYmd = ymd(base);
  const from = ymd(addDays(base, 1));
  const to = ymd(addDays(base, NOTICE_DAYS_BEFORE));
  const only = getTestMemberId();

  const nowAt = formatLocalDateTime(new Date()); // 활성 정지 판단 시각 — 프로세스 로컬 시각(백엔드와 같은 방식)
  const rows: Candidate[] = await AppDataSource.query(CANDIDATE_SQL(!!only), only ? [from, to, only, nowAt] : [from, to, nowAt]);
  log.info(`크레딧 만료 안내 후보: ${rows.length}건 (만료일 ${from} ~ ${to})`);

  const count: Record<Result | 'error', number> = { sent: 0, skipped: 0, failed: 0, error: 0 };
  for (const c of rows) {
    try {
      count[await noticeOne(c, baseYmd, log)] += 1;
    } catch (err) {
      count.error += 1;
      log.error(`크레딧 만료 안내 처리 오류 member=${c.member_id} end_dt=${c.end_dt}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info(`처리 결과: 안내 ${count.sent}, 이미 안내함 ${count.skipped}, 기록 실패 ${count.failed}, 오류 ${count.error}건`);
}
