import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { IsYn } from './enums';

@Entity('studio_class_time_table')
export class ClassTimeTable {
  @PrimaryGeneratedColumn('uuid')
  class_time_table_id: string;

  @Column({ type: 'uuid', nullable: true })
  class_id: string | null;

  @Column({ type: 'time', nullable: true })
  start_time: string | null;

  @Column({ type: 'time', nullable: true })
  end_time: string | null;

  @Column({ type: 'uuid', nullable: true })
  instructor_id: string | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_repeat: IsYn | null;

  @Column({ type: 'date', nullable: true })
  start_date: Date | null;

  @Column({ type: 'date', nullable: true })
  end_date: Date | null;

  @Column({ type: 'integer', nullable: true })
  duration: number | null;

  @Column({ type: 'integer', nullable: true })
  break_time: number | null;

  @Column({ type: 'integer', nullable: true })
  max_capacity: number | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_del: IsYn | null;
}
