import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { IsYn } from './enums';

@Entity('studio_class_repeat_day')
export class ClassRepeatDay {
  @PrimaryGeneratedColumn('uuid')
  repeat_day_id: string;

  @Column({ type: 'uuid', nullable: true })
  class_time_table_id: string | null;

  @Column({ type: 'text', nullable: true })
  day_of_week: string | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_del: IsYn | null;

  @Column({ type: 'timestamp', nullable: true })
  created_at: Date | null;
}
