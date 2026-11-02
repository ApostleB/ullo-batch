import { EntityManager } from 'typeorm';
import { MemberNotification } from '../entities/member-notification.entity';
import { IsYn } from '../entities/enums';

/**
 * 구독 해지 알림(카카오 알림톡 스텁) — 백엔드 src/common/notification/subscription-cancel-notifier.service.ts 와 같은 사유 코드·문구·기록 형식이다(복제).
 * 카카오 연동은 하지 않는다. 실제 발송 없이 member_notification 에 category=KAKAO_STUB 로 기록만 하며 앱 알림 목록에는 보이지 않는다.
 * 한쪽을 바꾸면 반드시 함께 바꾼다(spec 도 같은 문구를 확인한다).
 */

export const SubscriptionCancelReason = {
  USER_CANCELED: 'USER_CANCELED',
  RETRY_FAILED: 'RETRY_FAILED',
  MEMBER_SUSPENDED: 'MEMBER_SUSPENDED',
  OLD_PG_CARD: 'OLD_PG_CARD',
  REFUND: 'REFUND',
  ADMIN_CANCELED: 'ADMIN_CANCELED',
} as const;
export type SubscriptionCancelReasonType = (typeof SubscriptionCancelReason)[keyof typeof SubscriptionCancelReason];

const KAKAO_STUB_CATEGORY = 'KAKAO_STUB';

interface Message {
  title: string;
  body: string;
}

/** 크레딧 소멸 기한 같은 정책 문구는 넣지 않는다(정책 확인 중) */
const MESSAGES: Record<SubscriptionCancelReasonType, Message> = {
  USER_CANCELED: {
    title: '구독이 해지되었어요',
    body: '요청하신 대로 구독이 해지되었어요. 다음 결제일부터 결제되지 않아요.',
  },
  RETRY_FAILED: {
    title: '결제 실패로 구독이 해지되었어요',
    body: '결제가 두 번 실패해 구독이 해지되었어요. 다시 이용하시려면 결제 카드를 확인한 뒤 새로 구독해 주세요.',
  },
  MEMBER_SUSPENDED: {
    title: '이용 정지로 구독이 해지되었어요',
    body: '계정 이용이 정지되어 구독이 해지되었어요. 다음 결제일부터 결제되지 않아요. 자세한 내용은 고객센터로 문의해 주세요.',
  },
  OLD_PG_CARD: {
    title: '결제 카드 변경이 필요해 구독이 해지되었어요',
    body: '이전 결제 수단으로 등록된 카드는 더 이상 사용할 수 없어 결제일에 구독이 해지되었어요. 새 카드를 등록한 뒤 다시 구독해 주세요.',
  },
  REFUND: {
    title: '환불 처리로 구독이 해지되었어요',
    body: '구독 결제가 환불되어 구독이 해지되었어요. 다음 결제일부터 결제되지 않아요.',
  },
  ADMIN_CANCELED: {
    title: '구독이 해지되었어요',
    body: '운영 정책에 따라 구독이 해지되었어요. 다음 결제일부터 결제되지 않아요. 궁금한 점은 고객센터로 문의해 주세요.',
  },
};

export function buildSubscriptionCancelMessage(reason: SubscriptionCancelReasonType): Message {
  return MESSAGES[reason];
}

/**
 * 해지 알림을 기록한다. 호출자의 해지 트랜잭션 안에서 부르면 `manager.transaction`(SAVEPOINT)으로 감싸 알림 insert 실패가
 * 해지·결제 트랜잭션을 abort 시키지 않게 하고, 해지가 롤백되면 알림도 함께 사라진다. 실패는 로그만 남기고 삼킨다.
 */
export async function recordSubscriptionCancelNotice(
  manager: EntityManager,
  input: { memberId: string; memberPlanId: string; reason: SubscriptionCancelReasonType },
  log: { error: (message: string, meta?: unknown) => unknown },
): Promise<void> {
  const message = buildSubscriptionCancelMessage(input.reason);
  try {
    await manager.transaction(async (tx) => {
      await tx.insert(MemberNotification, {
        member_id: input.memberId,
        category: KAKAO_STUB_CATEGORY,
        title: message.title,
        body: message.body,
        link: `subscription/${input.memberPlanId}?reason=${input.reason}`,
        studio_id: null,
        is_read: IsYn.N,
        is_del: IsYn.N,
      });
    });
  } catch (err) {
    log.error(
      `[NOTIFY_FAILED] 구독 해지 알림 기록 실패(해지·결제에는 영향 없음) plan=${input.memberPlanId} reason=${input.reason}: ${(err as Error).message}`,
    );
  }
}
