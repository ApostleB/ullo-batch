import { decryptBillingKey, encryptBillingKey } from './billing-crypto.util';

/**
 * 이 유틸은 백엔드(`ullo/src/common/utils/billing-crypto.util.ts`)의 **미러**다.
 * 백엔드가 암호화해 저장한 빌링키를 배치가 복호화해 실제 청구하므로,
 * 한쪽만 알고리즘/포맷을 바꾸면 **구독 결제가 전부 실패**한다.
 *
 * 아래 고정 벡터는 백엔드 스펙의 것과 **동일한 값**이다(양쪽에 같은 벡터를 두어
 * 어느 쪽을 고치든 반대편 테스트가 깨지도록 한다).
 */
const FIXTURE = 'enc:v1:OUyF10i4NN9IcbL1:nFf5zSzo2dI2zHmThHzc/A==:fYeCVYUewYRwjznC0g0JX2gO0zk=';
const FIXTURE_SECRET = 'ullo-billing-test-secret';
const FIXTURE_PLAIN = 'BILLKEY-FIXTURE-0001';

const SECRET = 'test-billing-enc-secret';

describe('billing-crypto.util (배치 미러)', () => {
  it('고정 벡터 — 백엔드가 만든 암호문을 복호화할 수 있어야 한다', () => {
    // 깨졌다면 백엔드와 알고리즘·파생키·저장 포맷 중 하나가 어긋난 것이다.
    // 그 상태로 배포하면 모든 구독 청구가 빌링키 복호화 단계에서 실패한다.
    expect(decryptBillingKey(FIXTURE, FIXTURE_SECRET)).toBe(FIXTURE_PLAIN);
  });

  it('암호화 → 복호화 roundtrip', () => {
    const enc = encryptBillingKey('BILLKEY-1234567890', SECRET);
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(enc).not.toContain('BILLKEY-1234567890'); // 평문 미노출
    expect(decryptBillingKey(enc, SECRET)).toBe('BILLKEY-1234567890');
  });

  it('같은 평문도 매번 다른 암호문(IV 랜덤)', () => {
    const a = encryptBillingKey('K', SECRET);
    const b = encryptBillingKey('K', SECRET);
    expect(a).not.toBe(b);
    expect(decryptBillingKey(a, SECRET)).toBe('K');
  });

  it('프리픽스 없는 값은 레거시 평문으로 그대로 반환', () => {
    // 암호화 도입 전 저장된 토스 발급분 하위호환 — 여기서 throw 하면 레거시 구독이 전부 끊긴다.
    expect(decryptBillingKey('legacy-plain-billkey', SECRET)).toBe('legacy-plain-billkey');
  });

  it('다른 키/변조된 암호문은 복호화 실패(GCM 인증)', () => {
    const enc = encryptBillingKey('BILLKEY', SECRET);
    expect(() => decryptBillingKey(enc, 'wrong-secret')).toThrow();
    expect(() => decryptBillingKey(enc.slice(0, -4) + 'AAAA', SECRET)).toThrow();
  });
});
