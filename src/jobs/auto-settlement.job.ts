import { Not } from 'typeorm';
import { AppDataSource } from '../db/data-source';
import { Studio } from '../entities/studio.entity';
import { MemberClassSession } from '../entities/member-class-session.entity';
import { ClassSchedule } from '../entities/class-schedule.entity';
import { Settlement } from '../entities/settlement.entity';
import { SettlementPolicy } from '../entities/settlement-policy.entity';
import { ActiveStatus, IsYn, SessionStatus, SettlementStatus } from '../entities/enums';
import { config } from '../config';
import { ymd } from '../utils/date.util';
import { createJobLogger } from '../logger';

export const JOB_NAME = 'auto-settlement';

type Log = ReturnType<typeof createJobLogger>;

export async function execute(log: Log): Promise<void> {
  // 전월 기간
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const periodEnd = new Date(now.getFullYear(), now.getMonth(), 0, 0, 0, 0, 0); // 전월 말일
  log.info(`정산 기간: ${ymd(periodStart)} ~ ${ymd(periodEnd)}`);

  // 집계 기준일은 'YYYY-MM-DD' 문자열 (scheduled_date는 date 컬럼)
  const periodStartYmd = ymd(periodStart);
  const periodEndYmd = ymd(periodEnd);

  const studios = await AppDataSource.getRepository(Studio).find({ where: { is_del: IsYn.N } });
  const sessionRepo = AppDataSource.getRepository(MemberClassSession);
  const settlementRepo = AppDataSource.getRepository(Settlement);

  const policies = await AppDataSource.getRepository(SettlementPolicy).find({
    where: { is_active: ActiveStatus.Y, is_del: IsYn.N },
  });
  const studioPolicy = new Map(policies.filter((p) => p.studio_id).map((p) => [p.studio_id!, p]));
  const globalPolicy = policies.find((p) => !p.studio_id) ?? null;

  let created = 0;
  let skipped = 0;
  for (const studio of studios) {
    // 멱등 — 같은 (studio, 기간)에 '취소되지 않은' 정산이 있으면 스킵.
    // 백엔드 부분 유니크(settlement_studio_period_uq WHERE status<>'CANCELLED')와 대칭:
    // 취소된 정산만 있으면 재생성 허용(취소-후-재생성 정책).
    const dup = await settlementRepo.findOne({
      where: { studio_id: studio.studio_id, period_start: periodStart, status: Not(SettlementStatus.CANCELLED) },
    });
    if (dup) {
      skipped += 1;
      continue;
    }

    // 실제 수업일(class_schedule.scheduled_date) 기준으로 전월 완료 세션 집계.
    // session.created_at(행 생성 시각)은 수업 진행일과 무관하므로 사용하지 않는다.
    const totalSessions = await sessionRepo
      .createQueryBuilder('session')
      .innerJoin(ClassSchedule, 'sch', 'sch.class_schedule_id = session.class_schedule_id')
      .where('session.studio_id = :studioId', { studioId: studio.studio_id })
      .andWhere('session.session_status = :status', { status: SessionStatus.COMPLETED })
      .andWhere('session.is_del = :isDel', { isDel: IsYn.N })
      // 소프트 삭제된 스케줄(취소 수업)은 정산에서 제외. IS DISTINCT FROM으로 is_del=NULL 행은 유지(정상 스케줄).
      .andWhere('sch.is_del IS DISTINCT FROM :schDel', { schDel: IsYn.Y })
      .andWhere('sch.scheduled_date BETWEEN :start AND :end', {
        start: periodStartYmd,
        end: periodEndYmd,
      })
      .getCount();
    if (totalSessions === 0) {
      skipped += 1;
      continue;
    }

    // 단가/수수료율: 스튜디오 정책 > 전역 정책 > env 기본값
    const policy = studioPolicy.get(studio.studio_id) ?? globalPolicy;
    const unitPrice = policy?.unit_price ?? config.params.settlementDefaultUnitPrice;
    const rate = policy ? Number(policy.commission_rate) : config.params.settlementDefaultCommissionRate;

    const gross = totalSessions * unitPrice;
    const commission = Math.round(gross * rate);
    const net = gross - commission;

    await settlementRepo.save(
      settlementRepo.create({
        studio_id: studio.studio_id,
        period_start: periodStart,
        period_end: periodEnd,
        total_sessions: totalSessions,
        gross_amount: gross,
        commission,
        net_amount: net,
        status: SettlementStatus.PENDING,
        paid_at: null,
        created_at: new Date(),
      }),
    );
    created += 1;
    log.info(`정산 생성 studio=${studio.studio_id} sessions=${totalSessions} net=${net}`);
  }
  log.info(`정산 결과: 생성 ${created}, 스킵 ${skipped}`);
}
