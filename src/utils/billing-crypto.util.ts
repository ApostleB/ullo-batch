import { createDecipheriv, createHash } from 'crypto';

/**
 * 빌링키 복호화 (AES-256-GCM) — 백엔드(ullo) src/common/utils/billing-crypto.util.ts 미러.
 * member_billing.billing_key 는 유출 시 임의 청구가 가능한 재사용 키라 백엔드가 암호화 저장한다.
 * 저장 포맷: `enc:v1:<iv b64>:<authTag b64>:<ciphertext b64>`
 * - 프리픽스가 없는 값은 암호화 도입 전 저장된 레거시 평문으로 간주하고 그대로 반환한다.
 * - 키는 BILLING_KEY_ENC_KEY 를 SHA-256 으로 32byte 유도(백엔드와 동일해야 복호화 가능).
 * ⚠️ 포맷 변경 시 백엔드와 반드시 함께 수정할 것.
 */
const PREFIX = 'enc:v1:';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function isEncryptedBillingKey(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export function decryptBillingKey(stored: string, secret: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // 레거시 평문
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
