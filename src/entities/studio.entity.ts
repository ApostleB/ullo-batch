import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ActiveStatus, IsYn } from './enums';

@Entity('studio')
export class Studio {
  @PrimaryGeneratedColumn('uuid')
  studio_id: string;

  @Column({ type: 'text', nullable: true })
  studio_name: string | null;

  @Column({ type: 'uuid', nullable: true })
  partner_id: string | null;

  @Column({ type: 'enum', enum: ActiveStatus, enumName: 'active_status', default: ActiveStatus.Y, nullable: true })
  is_active: ActiveStatus | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_del: IsYn | null;
}
