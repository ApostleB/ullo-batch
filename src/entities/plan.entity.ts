import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ActiveStatus, IsYn } from './enums';

@Entity('plan')
export class Plan {
  @PrimaryGeneratedColumn('uuid')
  plan_id: string;

  @Column({ type: 'text', nullable: true })
  plan_title: string | null;

  @Column({ type: 'text', nullable: true })
  plan_desc: string | null;

  @Column({ type: 'text', nullable: true })
  plan_type: string | null;

  @Column({ type: 'integer', nullable: true })
  actual_amount: number | null;

  @Column({ type: 'integer', nullable: true })
  credit: number | null;

  @Column({ type: 'enum', enum: ActiveStatus, enumName: 'active_status', default: ActiveStatus.Y, nullable: true })
  is_active: ActiveStatus | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_del: IsYn | null;
}
