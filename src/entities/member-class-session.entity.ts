import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { IsYn } from './enums';

@Entity('member_class_session')
export class MemberClassSession {
  @PrimaryGeneratedColumn('uuid')
  member_class_session_id: string;

  @Column({ type: 'uuid', nullable: true })
  member_id: string | null;

  @Column({ type: 'text', nullable: true })
  session_status: string | null;

  @Column({ type: 'uuid', nullable: true })
  studio_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  class_id: string | null;

  @Column({ type: 'uuid', nullable: true })
  class_schedule_id: string | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', nullable: true })
  is_del: IsYn | null;

  @Column({ type: 'timestamp', nullable: true })
  created_at: Date | null;

  /** 수업 완료 시각 — 파트너 수동 완료 또는 session-auto-complete 잡이 채운다(리뷰 허용기간 기준). */
  @Column({ type: 'timestamp', nullable: true })
  completed_at: Date | null;

  @Column({ type: 'integer', nullable: true })
  credit_amount: number | null;
}
