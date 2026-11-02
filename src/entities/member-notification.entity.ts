import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { IsYn } from './enums';

/**
 * 회원 알림 — 배치는 구독 해지 알림(카카오 알림톡 스텁)을 기록하는 데만 쓴다. 조회·읽음 처리는 백엔드 소관.
 * 백엔드 src/entities/member-notification.entity.ts 와 컬럼이 같아야 한다(테이블은 이미 존재, 스키마 변경 없음).
 */
@Entity('member_notification')
export class MemberNotification {
  @PrimaryGeneratedColumn('uuid')
  notification_id: string;

  @Column({ type: 'uuid' })
  member_id: string;

  /** 'KAKAO_STUB' — 앱 알림 목록에는 노출되지 않는다(백엔드 목록은 CENTER 행만 조회) */
  @Column({ type: 'text' })
  category: string;

  @Column({ type: 'text', nullable: true })
  title: string | null;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'text', nullable: true })
  link: string | null;

  @Column({ type: 'uuid', nullable: true })
  studio_id: string | null;

  @Column({ type: 'varchar', length: 1, default: IsYn.N })
  is_read: IsYn;

  @Column({ type: 'varchar', length: 1, default: IsYn.N })
  is_del: IsYn;

  @CreateDateColumn({ type: 'timestamp', nullable: true })
  created_at: Date | null;
}
