import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { IsYn } from './enums';

/**
 * 탈퇴 회원 분리보관 테이블 (백엔드 src/entities/member-withdrawal.entity.ts 와 동일 스키마).
 * purge_at 경과분을 member-purge 잡이 최종 파기한다.
 */
@Entity('member_withdrawal')
@Index('member_withdrawal_purge_idx', ['is_purged', 'purge_at'])
export class MemberWithdrawal {
  @PrimaryGeneratedColumn('uuid')
  member_withdrawal_id: string;

  @Column({ type: 'uuid' })
  member_id: string;

  @Column({ type: 'text', nullable: true })
  member_email: string | null;

  @Column({ type: 'text', nullable: true })
  member_name: string | null;

  @Column({ type: 'text', nullable: true })
  member_nickname: string | null;

  @Column({ type: 'text', nullable: true })
  member_mobile: string | null;

  @Column({ type: 'text', nullable: true })
  gender: string | null;

  @Column({ type: 'text', nullable: true })
  provider_ref: string | null;

  @Column({ type: 'text', nullable: true })
  withdraw_reason: string | null;

  @Column({ type: 'timestamp' })
  withdrawn_at: Date;

  @Column({ type: 'timestamp' })
  purge_at: Date;

  @Column({ type: 'enum', enum: IsYn, enumName: 'is_yn', default: IsYn.N })
  is_purged: IsYn;

  @Column({ type: 'timestamp', nullable: true })
  purged_at: Date | null;

  @Column({ type: 'timestamp', default: () => 'now()' })
  created_at: Date;
}
