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
 * 같은 트랜잭션에서 이번에 파기된 회원의 파트너 회원 메모(partner_member_memo)를
 * is_del 과 무관하게 물리 삭제한다(W5c). 메모 삭제가 실패하면 파기 UPDATE 도 롤백되어
 * 다음 실행에서 둘 다 다시 시도된다. 탈퇴 즉시 파트너 화면에서 숨기는 것은 백엔드 몫이다.
 * ⚠️ partner_member_memo DDL(ullo W5a) 적용 후에만 배포한다 — 테이블이 없으면 파기 자체가 멈춘다.
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

  const { purged, memosDeleted } = await AppDataSource.transaction(async (m) => {
    const res = await m
      .getRepository(MemberWithdrawal)
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
      .returning(['member_id'])
      .execute();

    // 이번 UPDATE 가 N→Y 로 바꾼 행의 회원만 — 이전 실행에서 파기된 회원은 다시 잡히지 않는다
    const rows: Array<{ member_id: string }> = Array.isArray(res.raw) ? res.raw : [];
    const memberIds = [...new Set(rows.map((r) => r.member_id).filter(Boolean))];
    if (memberIds.length === 0) {
      return { purged: res.affected ?? 0, memosDeleted: 0 };
    }

    // 같은 트랜잭션의 QueryRunner — useStructuredResult 로 삭제 건수(affected)를 받는다
    const del = await m.queryRunner!.query(
      `DELETE FROM partner_member_memo WHERE member_id = ANY($1::uuid[])`,
      [memberIds],
      true,
    );
    return { purged: res.affected ?? rows.length, memosDeleted: del.affected ?? 0 };
  });

  // member_id·메모 내용은 로그에 남기지 않는다(건수만)
  log.info(
    `분리보관 개인정보 파기 완료: 대상 ${targetCount} / 처리 ${purged}건, 파트너 회원 메모 삭제 ${memosDeleted}건`,
  );
}
