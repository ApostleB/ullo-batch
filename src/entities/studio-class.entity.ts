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
}
