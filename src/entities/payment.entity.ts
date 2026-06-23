import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('payment')
export class Payment {
  @PrimaryGeneratedColumn('uuid')
  payment_id: string;

  @Column({ type: 'uuid', nullable: true })
  member_id: string | null;

  @Column({ type: 'text', nullable: true })
  payment_type: string | null;

  @Column({ type: 'text', nullable: true })
  purchase_type: string | null;

  @Column({ type: 'uuid', nullable: true })
  plan_id: string | null;

  @Column({ type: 'integer', nullable: true })
  grant_credit: number | null;

  @Column({ type: 'integer', nullable: true })
  amount: number | null;

  @Column({ type: 'text', nullable: true })
  currency: string | null;

  @Column({ type: 'text', nullable: true })
  status: string | null;

  @Column({ type: 'text', nullable: true })
  order_id: string | null;

  @Column({ type: 'text', nullable: true })
  order_name: string | null;

  @Column({ type: 'text', nullable: true })
  pg_provider: string | null;

  @Column({ type: 'text', nullable: true })
  payment_key: string | null;

  @Column({ type: 'text', nullable: true })
  method: string | null;

  @Column({ type: 'text', nullable: true })
  pg_transaction_id: string | null;

  @Column({ type: 'text', nullable: true })
  fail_code: string | null;

  @Column({ type: 'text', nullable: true })
  fail_reason: string | null;

  @Column({ type: 'timestamp', nullable: true })
  paid_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  requested_at: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  updated_at: Date | null;
}
