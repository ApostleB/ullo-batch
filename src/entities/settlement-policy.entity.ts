import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ActiveStatus, IsYn } from './enums';

@Entity('settlement_policy')
export class SettlementPolicy {
  @PrimaryGeneratedColumn('uuid')
  settlement_policy_id: string;

  /** NULL = 전역 기본 정책 */
  @Column({ type: 'uuid', nullable: true })
  studio_id: string | null;

  @Column({ type: 'integer' })
  unit_price: number;

  @Column({ type: 'numeric' })
  commission_rate: string;

  @Column({ type: 'enum', enum: ActiveStatus, enumName: 'active_status', default: ActiveStatus.Y, nullable: true })
  is_active: ActiveStatus | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_del: IsYn | null;

  @Column({ type: 'timestamp', nullable: true })
  created_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  updated_at: Date | null;
}
