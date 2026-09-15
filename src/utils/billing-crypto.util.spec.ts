import { decryptBillingKey, isEncryptedBillingKey } from './billing-crypto.util';

/**
 * 이 유틸은 백엔드(`ullo/src/common/utils/billing-crypto.util.ts`)의 **미러**다.
 * 백엔드가 암호화해 저장한 빌링키를 배치가 복호화해 실제 청구하므로,
 * 한쪽만 알고리즘·파생키·저장 포맷을 바꾸면 **구독 결제가 전부 실패**한다.
 *
 * 배치 쪽은 복호화만 갖는다(암호화는 백엔드의 몫). 그래서 roundtrip 대신
 * **백엔드가 만든 고정 벡터**로 계약을 고정한다 — 백엔드 스펙에 있는 것과 같은 값이라
 * 어느 쪽을 고치든 반대편 테스트가 깨진다.
 */
const FIXTURE = 'enc:v1:OUyF10i4NN9IcbL1:nFf5zSzo2dI2zHmThHzc/A==:fYeCVYUewYRwjznC0g0JX2gO0zk=';
const FIXTURE_SECRET = 'ullo-billing-test-secret';
const FIXTURE_PLAIN = 'BILLKEY-FIXTURE-0001';

describe('billing-crypto.util (배치 미러 — 복호화 전용)', () => {
  it('고정 벡터 — 백엔드가 만든 암호문을 복호화할 수 있어야 한다', () => {
    // 깨졌다면 백엔드와 알고리즘·파생키·저장 포맷 중 하나가 어긋난 것이다.
    // 그 상태로 배포하면 모든 구독 청구가 빌링키 복호화 단계에서 실패한다.
    expect(decryptBillingKey(FIXTURE, FIXTURE_SECRET)).toBe(FIXTURE_PLAIN);
  });

  it('프리픽스 없는 값은 레거시 평문으로 그대로 반환', () => {
    // 암호화 도입 전 저장된 토스 발급분 하위호환 — 여기서 throw 하면 레거시 구독이 전부 끊긴다.
    expect(decryptBillingKey('legacy-plain-billkey', FIXTURE_SECRET)).toBe('legacy-plain-billkey');
  });

  it('암호화 여부를 프리픽스로 판정한다', () => {
    expect(isEncryptedBillingKey(FIXTURE)).toBe(true);
    expect(isEncryptedBillingKey('legacy-plain-billkey')).toBe(false);
  });

  it('키가 다르면 복호화에 실패한다(GCM 인증)', () => {
    expect(() => decryptBillingKey(FIXTURE, 'wrong-secret')).toThrow();
  });

  it('암호문이 변조되면 복호화에 실패한다(GCM 인증)', () => {
    const tampered = FIXTURE.slice(0, -5) + 'AAAA=';
    expect(() => decryptBillingKey(tampered, FIXTURE_SECRET)).toThrow();
  });
});
