import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { IsYn } from './enums';

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

  @Column({ type: 'uuid', nullable: true })
  instructor_id: string | null;

  @Column({ type: 'timestamp', nullable: true })
  updated_at: Date | null;
}
