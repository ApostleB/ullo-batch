import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * 공공데이터포털 특일정보(공휴일/국경일) 캐시 테이블.
 * locdate(YYYYMMDD) + seq 조합으로 하루에 복수 항목(예: 대체공휴일)도 구분한다.
 */
@Entity('holiday')
@Unique('holiday_locdate_seq_uk', ['locdate', 'seq'])
export class Holiday {
  @PrimaryGeneratedColumn('uuid')
  holiday_id: string;

  @Index('holiday_locdate_idx')
  @Column({ type: 'integer' })
  locdate: number; // YYYYMMDD

  @Column({ type: 'integer', default: 1 })
  seq: number;

  @Column({ type: 'text' })
  date_name: string;

  @Column({ type: 'varchar', length: 1 })
  is_holiday: string; // 'Y' | 'N'

  @Column({ type: 'varchar', length: 2, nullable: true })
  date_kind: string | null; // 01: 국경일, 02: 기념일, 03: 24절기, 04: 잡절

  @Column({ type: 'timestamp', nullable: true })
  created_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  updated_at: Date | null;
}
