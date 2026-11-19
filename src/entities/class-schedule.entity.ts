import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { IsYn } from './enums';

/**
 * 칸 키 UNIQUE(U-6). DB 인덱스는 ullo docs/ddl/2026-11-18_u6_slot_on_booking.sql #3 이 만든다(synchronize 꺼짐 — 여기 선언은
 * ullo 엔티티와 맞춘 문서용). ullo slot-materializer 의 ON CONFLICT 가 이 인덱스를 추론 대상으로 쓴다. 배치는 회차를 만들지 않는다.
 */
@Index('ux_studio_class_schedule_slot_key', ['class_time_table_id', 'scheduled_date', 'origin_start_time'], {
  unique: true,
  where: `"is_del" = 'N'`,
})
@Entity('studio_class_schedule')
export class ClassSchedule {
  @PrimaryGeneratedColumn('uuid')
  class_schedule_id: string;

  @Column({ type: 'uuid', nullable: true })
  class_time_table_id: string | null;

  @Column({ type: 'date', nullable: true })
  scheduled_date: Date | null;

  @Column({ type: 'integer', default: 0, nullable: true })
  current_capacity: number | null;

  @Column({ type: 'integer', nullable: true })
  max_capacity: number | null;

  @Column({ type: 'text', default: 'OPEN', nullable: true })
  status: string | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_del: IsYn | null;

  @Column({ type: 'timestamp', nullable: true })
  created_at: Date | null;

  @Column({ type: 'uuid', nullable: true })
  created_partner_id: string | null;

  @Column({ type: 'time', nullable: true })
  start_time: string | null;

  @Column({ type: 'time', nullable: true })
  end_time: string | null;

  /**
   * 원래 칸 시작 시각(U-6 칸 키 = 시간표·날짜·이 값). 회차 시각(start_time)을 옮겨도 바뀌지 않는다.
   * 전환 기간에는 NULL 허용이고 DB BEFORE INSERT 트리거가 NULL 을 start_time 으로 채운다(S14).
   * DDL: ullo docs/ddl/2026-11-18_u6_slot_on_booking.sql #2 (ullo ClassSchedule 엔티티와 같은 정의. 배치 잡은 이 값을 쓰지 않는다 —
   * 이 DDL 적용 뒤에만 엔티티 전체 조회가 동작한다)
   */
  @Column({ type: 'time', nullable: true })
  origin_start_time: string | null;

  @Column({ type: 'uuid', nullable: true })
  instructor_id: string | null;

  @Column({ type: 'timestamp', nullable: true })
  updated_at: Date | null;

  // 취소 추적 (ullo 백엔드 엔티티와 같은 물리 컬럼 — 배치 로직은 쓰지 않는다)
  @Column({ type: 'timestamp', nullable: true })
  cancelled_at: Date | null;

  // MEMBER | PARTNER | ADMIN | SYSTEM
  @Column({ type: 'text', nullable: true })
  cancelled_by_type: string | null;

  @Column({ type: 'uuid', nullable: true })
  cancelled_by_id: string | null;

  // POLICY_VIOLATION | PAYMENT_ISSUE | SAFETY | ETC | CENTER_REQUEST | CLASS_HOLIDAY | CENTER_HOLIDAY
  // (ullo CancelReasonCode 와 같은 값. CLASS_HOLIDAY·CENTER_HOLIDAY = 수업·센터 휴무, 어드민 날짜 일괄 취소·회차 취소 전용, U-6 S26)
  @Column({ type: 'text', nullable: true })
  cancel_reason_code: string | null;

  @Column({ type: 'text', nullable: true })
  cancel_reason_detail: string | null;

  // 외부 강사 (ullo 백엔드 엔티티와 같은 물리 컬럼 — 배치 로직은 쓰지 않는다)
  @Column({ type: 'text', nullable: true })
  external_instructor_name: string | null;

  @Column({ type: 'text', nullable: true })
  external_instructor_phone: string | null;
}
