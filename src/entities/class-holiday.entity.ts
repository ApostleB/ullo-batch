import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('studio_class_holiday')
export class ClassHoliday {
  @PrimaryGeneratedColumn('uuid')
  class_holiday_id: string;

  @Column({ type: 'uuid', nullable: true })
  class_id: string | null;

  @Column({ type: 'text', nullable: true })
  holiday_type: string | null;

  @Column({ type: 'date', nullable: true })
  holiday_date: Date | null;

  @Column({ type: 'uuid', nullable: true })
  studio_id: string | null;
}
