import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ActiveStatus, IsYn } from './enums';

@Entity('member_plan')
export class MemberPlan {
  @PrimaryGeneratedColumn('uuid')
  member_plan_id: string;

  @Column({ type: 'uuid' })
  member_id: string;

  @Column({ type: 'uuid' })
  plan_id: string;

  @Column({ type: 'enum', enum: ActiveStatus, enumName: 'active_status', nullable: true })
  is_active: ActiveStatus | null;

  @Column({ type: 'date' })
  start_dt: Date;

  @Column({ type: 'date' })
  end_dt: Date;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_del: IsYn | null;

  @Column({ type: 'timestamp', nullable: true })
  created_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  updated_at: Date | null;

  // ===== 구독(정기결제) =====
  @Column({ type: 'uuid', nullable: true })
  member_billing_id: string | null;

  @Column({ type: 'date', nullable: true })
  next_charge_dt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  pending_plan_id: string | null;

  @Column({ type: 'text', nullable: true })
  status: string | null;

  @Column({ type: 'uuid', nullable: true })
  last_payment_id: string | null;

  @Column({ type: 'timestamp', nullable: true })
  canceled_at: Date | null;
}
