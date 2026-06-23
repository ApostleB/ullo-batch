import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { IsYn } from './enums';

@Entity('member_credit_log')
export class MemberCreditLog {
  @PrimaryGeneratedColumn('uuid')
  member_credit_log_id: string;

  @Column({ type: 'uuid', nullable: true })
  member_credit_id: string | null;

  @Column({ type: 'integer', nullable: true })
  credit_action: number | null;

  @Column({ type: 'text', nullable: true })
  credit_type: string | null;

  @Column({ type: 'text', nullable: true })
  log_title: string | null;

  @Column({ type: 'text', nullable: true })
  log_desc: string | null;

  @Column({ type: 'integer', nullable: true })
  total_credit: number | null;

  @Column({ type: 'integer', nullable: true })
  credit: number | null;

  @Column({ type: 'uuid', nullable: true })
  studio_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  class_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  member_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  partner_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  admin_id: string | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_member_view: IsYn | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_partner_view: IsYn | null;

  @Column({ type: 'timestamp', nullable: true })
  created_at: Date | null;
}
