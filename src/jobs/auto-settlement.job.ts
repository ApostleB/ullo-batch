import { Between } from 'typeorm';
import { AppDataSource } from '../db/data-source';
import { Studio } from '../entities/studio.entity';
import { MemberClassSession } from '../entities/member-class-session.entity';
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
  const periodEndOfDay = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  log.info(`정산 기간: ${ymd(periodStart)} ~ ${ymd(periodEnd)}`);

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
    // 멱등 — 같은 (studio, 기간) 정산 있으면 스킵
    const dup = await settlementRepo.findOne({
      where: { studio_id: studio.studio_id, period_start: periodStart },
    });
    if (dup) {
      skipped += 1;
      continue;
    }

    const totalSessions = await sessionRepo.count({
      where: {
        studio_id: studio.studio_id,
        session_status: SessionStatus.COMPLETED,
        is_del: IsYn.N,
        created_at: Between(periodStart, periodEndOfDay),
      },
    });
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
