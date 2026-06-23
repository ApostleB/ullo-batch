import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { ActiveStatus, IsYn } from './enums';

@Entity('member_billing')
export class MemberBilling {
  @PrimaryGeneratedColumn('uuid')
  member_billing_id: string;

  @Column({ type: 'uuid' })
  member_id: string;

  @Column({ type: 'text' })
  customer_key: string;

  @Column({ type: 'text' })
  billing_key: string;

  @Column({ type: 'text', nullable: true })
  card_company: string | null;

  @Column({ type: 'text', nullable: true })
  card_number_masked: string | null;

  @Column({ type: 'text', nullable: true })
  card_type: string | null;

  @Column({ type: 'enum', enum: ActiveStatus, enumName: 'active_status', default: ActiveStatus.Y, nullable: true })
  is_active: ActiveStatus | null;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N, nullable: true })
  is_del: IsYn | null;
}
