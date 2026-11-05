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

  @Column({ type: 'integer', nullable: true })
  credit_amount: number | null;

  // 취소 추적 (ullo 백엔드 엔티티와 같은 물리 컬럼 — 배치 로직은 쓰지 않는다)
  @Column({ type: 'timestamp', nullable: true })
  cancelled_at: Date | null;

  // MEMBER | PARTNER | ADMIN | SYSTEM
  @Column({ type: 'text', nullable: true })
  cancelled_by_type: string | null;

  @Column({ type: 'uuid', nullable: true })
  cancelled_by_id: string | null;

  // POLICY_VIOLATION | PAYMENT_ISSUE | SAFETY | ETC | CENTER_REQUEST
  @Column({ type: 'text', nullable: true })
  cancel_reason_code: string | null;

  @Column({ type: 'text', nullable: true })
  cancel_reason_detail: string | null;
}
