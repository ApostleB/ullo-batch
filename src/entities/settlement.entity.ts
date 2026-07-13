import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// 멱등 백업 — (studio_id, period_start) 부분 유니크(취소 제외). 백엔드 DDL settlement_studio_period_uq와 정합.
// synchronize:false 이므로 실효는 수동 DDL 적용에 달려 있고, 이 선언은 스키마 문서화 목적.
@Entity('settlement')
@Index('settlement_studio_period_uq', ['studio_id', 'period_start'], { unique: true, where: "status <> 'CANCELLED'" })
export class Settlement {
  @PrimaryGeneratedColumn('uuid')
  settlement_id: string;

  @Column({ type: 'uuid', nullable: true })
  studio_id: string | null;

  @Column({ type: 'date', nullable: true })
  period_start: Date | null;

  @Column({ type: 'date', nullable: true })
  period_end: Date | null;

  @Column({ type: 'integer', nullable: true })
  total_sessions: number | null;

  @Column({ type: 'integer', nullable: true })
  gross_amount: number | null;

  @Column({ type: 'integer', nullable: true })
  commission: number | null;

  @Column({ type: 'integer', nullable: true })
  net_amount: number | null;

  // 수동 조정(P3-8, 백엔드 admin) — 배치는 읽지 않지만 스키마 정합을 위해 미러.
  @Column({ type: 'integer', nullable: true })
  adjustment_amount: number | null;

  @Column({ type: 'text', nullable: true })
  adjustment_reason: string | null;

  @Column({ type: 'text', nullable: true })
  status: string | null;

  @Column({ type: 'timestamp', nullable: true })
  paid_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  created_at: Date | null;
}
