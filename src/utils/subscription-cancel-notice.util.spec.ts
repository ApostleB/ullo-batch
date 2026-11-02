import {
  SubscriptionCancelReason,
  buildSubscriptionCancelMessage,
  recordKakaoStubNotice,
  recordSubscriptionCancelNotice,
} from './subscription-cancel-notice.util';

const REASONS = Object.values(SubscriptionCancelReason);

/**
 * 백엔드 src/common/notification/subscription-cancel-notifier.service.ts 의 문구·사유 코드와 같다 — 한쪽을 바꾸면 함께 바꾼다.
 */
describe('구독 해지 알림 문구 (백엔드와 일치)', () => {
  it('사유 코드는 백엔드와 같다', () => {
    expect(REASONS.sort()).toEqual(
      ['ADMIN_CANCELED', 'MEMBER_SUSPENDED', 'OLD_PG_CARD', 'REFUND', 'RETRY_FAILED', 'USER_CANCELED'].sort(),
    );
  });

  it.each([
    ['RETRY_FAILED', '결제 실패로 구독이 해지되었어요', '결제가 두 번 실패해 구독이 해지되었어요. 다시 이용하시려면 결제 카드를 확인한 뒤 새로 구독해 주세요.'],
    [
      'MEMBER_SUSPENDED',
      '이용 정지로 구독이 해지되었어요',
      '계정 이용이 정지되어 구독이 해지되었어요. 다음 결제일부터 결제되지 않아요. 자세한 내용은 고객센터로 문의해 주세요.',
    ],
    [
      'OLD_PG_CARD',
      '결제 카드 변경이 필요해 구독이 해지되었어요',
      '이전 결제 수단으로 등록된 카드는 더 이상 사용할 수 없어 결제일에 구독이 해지되었어요. 새 카드를 등록한 뒤 다시 구독해 주세요.',
    ],
  ])('%s 문구', (reason, title, body) => {
    expect(buildSubscriptionCancelMessage(reason as any)).toEqual({ title, body });
  });

  it.each(REASONS)('%s 문구에 크레딧 소멸 기한 같은 정책 문구가 없다', (reason) => {
    const m = buildSubscriptionCancelMessage(reason);
    expect(`${m.title} ${m.body}`).not.toMatch(/크레딧|소멸|15일|유효기간/);
  });
});

describe('recordSubscriptionCancelNotice — 실제 발송 없이 member_notification 에 기록만', () => {
  const input = { memberId: 'm1', memberPlanId: 'mp1', reason: SubscriptionCancelReason.RETRY_FAILED };
  const log = { error: jest.fn() };
  beforeEach(() => jest.clearAllMocks());

  it('SAVEPOINT(manager.transaction) 안에서 KAKAO_STUB 카테고리로 insert 한다', async () => {
    const insert = jest.fn().mockResolvedValue(undefined);
    const tx = { insert };
    const manager = { transaction: jest.fn(async (cb: (t: any) => Promise<void>) => cb(tx)) };
    await recordSubscriptionCancelNotice(manager as any, input, log);
    expect(manager.transaction).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        member_id: 'm1',
        category: 'KAKAO_STUB',
        title: buildSubscriptionCancelMessage('RETRY_FAILED').title,
        body: buildSubscriptionCancelMessage('RETRY_FAILED').body,
        link: 'subscription/mp1?reason=RETRY_FAILED',
        is_read: 'N',
        is_del: 'N',
      }),
    );
  });

  it('기록이 실패해도 throw 하지 않는다(해지·결제 트랜잭션을 깨지 않는다)', async () => {
    const manager = { transaction: jest.fn().mockRejectedValue(new Error('insert failed')) };
    await expect(recordSubscriptionCancelNotice(manager as any, input, log)).resolves.toBeUndefined();
    expect((log.error as jest.Mock).mock.calls[0][0]).toContain('NOTIFY_FAILED');
  });
});

describe('recordKakaoStubNotice — 해지·만료 안내 공용 기록(성공 여부를 돌려준다)', () => {
  const log = { error: jest.fn() };
  const input = { memberId: 'm1', title: 't', body: 'b', link: 'credit-expiry?end_dt=2026-12-03' };

  it('성공하면 true, 실패하면 false(throw 하지 않음)', async () => {
    const ok = { transaction: jest.fn(async (cb: any) => cb({ insert: jest.fn() })) };
    await expect(recordKakaoStubNotice(ok as any, input, log)).resolves.toBe(true);
    const bad = { transaction: jest.fn().mockRejectedValue(new Error('x')) };
    await expect(recordKakaoStubNotice(bad as any, input, log)).resolves.toBe(false);
    expect(log.error.mock.calls[0][0]).toContain('NOTIFY_FAILED');
  });
});
