import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { IsYn } from './enums';

@Entity('member_credit')
export class MemberCredit {
  @PrimaryGeneratedColumn('uuid')
  member_credit_id: string;

  @Column({ type: 'uuid', nullable: true })
  member_id: string | null;

  @Column({ type: 'text', nullable: true })
  credit_type: string | null;

  @Column({ type: 'integer', nullable: true })
  init_credit: number | null;

  @Column({ type: 'integer', nullable: true })
  credit: number | null;

  @Column({ type: 'text', nullable: true })
  membership_title: string | null;

  @Column({ type: 'text', nullable: true })
  membership_desc: string | null;

  @Column({ type: 'uuid', nullable: true })
  member_membership_id: string | null;

  // 이 lot 을 지급한 결제 — 자동환불 판정·환불 회수 귀속용(백엔드 미러). 쿠폰/수동 지급은 null.
  @Column({ type: 'uuid', nullable: true })
  source_payment_id: string | null;

  @Column({ type: 'date', nullable: true })
  start_dt: Date | null;

  @Column({ type: 'date', nullable: true })
  end_dt: Date | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_del: IsYn | null;

  @Column({ type: 'timestamp', nullable: true })
  created_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  updated_at: Date | null;
}
