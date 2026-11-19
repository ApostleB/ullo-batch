import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ActiveStatus, IsYn } from './enums';

@Entity('studio_class')
export class StudioClass {
  @PrimaryGeneratedColumn('uuid')
  class_id: string;

  @Column({ type: 'uuid', nullable: true })
  studio_id: string | null;

  @Column({ type: 'text', nullable: true })
  class_name: string | null;

  @Column({ type: 'integer', nullable: true })
  credit: number | null;

  @Column({ type: 'integer', nullable: true })
  max_capacity: number | null;

  @Column({ type: 'enum', enum: ActiveStatus, enumName: 'active_status', nullable: true })
  is_active: ActiveStatus | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', nullable: true })
  is_del: IsYn | null;

  /**
   * 최대 예약 가능 기간(일, U-6). 앱 예약 가능 범위 = 오늘 ~ min(오늘+이 값, 시간표 종료일).
   * DB CHECK ck_studio_class_booking_window_days: 7·14·21·30·60. DDL: ullo docs/ddl/2026-11-18_u6_slot_on_booking.sql #1
   * (ullo StudioClass 엔티티와 같은 정의. 배치 잡은 이 값을 쓰지 않는다 — 이 DDL 적용 뒤에만 엔티티 전체 조회가 동작한다)
   */
  @Column({ type: 'smallint', default: 14 })
  booking_window_days: number;
}
