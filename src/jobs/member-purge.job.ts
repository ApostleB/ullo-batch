import { LessThanOrEqual } from 'typeorm';
import { AppDataSource } from '../db/data-source';
import { MemberWithdrawal } from '../entities/member-withdrawal.entity';
import { IsYn } from '../entities/enums';
import { createJobLogger } from '../logger';

export const JOB_NAME = 'member-purge';

type Log = ReturnType<typeof createJobLogger>;

/**
 * 탈퇴 회원 분리보관 개인정보 최종 파기 — 매일 실행.
 *
 * 탈퇴 시 라이브 member 는 이미 익명화됐고, 개인정보 스냅샷만 member_withdrawal 에
 * 보관 중이다. purge_at(탈퇴+보관기간)이 지난 행의 개인정보를 제거하고 is_purged=Y 로
 * 표시한다. member_id·탈퇴/파기 시각만 남는 무-PII 툼스톤이 되어 감사 추적은 유지된다.
 *
 * 멱등: is_purged=Y 는 다시 선택되지 않으므로 재실행·중복 실행에도 안전하다.
 */
export async function execute(log: Log): Promise<void> {
  const repo = AppDataSource.getRepository(MemberWithdrawal);
  const now = new Date();

  const targetCount = await repo.count({
    where: { is_purged: IsYn.N, purge_at: LessThanOrEqual(now) },
  });
  if (targetCount === 0) {
    log.info('파기 대상 없음 — 종료');
    return;
  }

  const res = await repo
    .createQueryBuilder()
    .update()
    .set({
      member_email: null,
      member_name: null,
      member_nickname: null,
      member_mobile: null,
      gender: null,
      provider_ref: null,
      withdraw_reason: null,
      is_purged: IsYn.Y,
      purged_at: now,
    })
    .where('is_purged = :n', { n: IsYn.N })
    .andWhere('purge_at <= :now', { now })
    .execute();

  log.info(`분리보관 개인정보 파기 완료: 대상 ${targetCount} / 처리 ${res.affected ?? 0}건`);
}
