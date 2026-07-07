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

  /**
   * 자동결제 PG 구분 — 'TOSS' | 'INICIS'. NULL = 레거시(마이그레이션 이전 토스 발급분).
   * subscription-billing 잡이 이 값으로 청구 클라이언트를 분기한다.
   * DDL: sql/member-billing-provider.sql (재활성화 전 반드시 적용).
   */
  @Column({ type: 'text', nullable: true })
  provider: string | null;

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
