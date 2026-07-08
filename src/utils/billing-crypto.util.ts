import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * 빌링키 저장용 암호화 (AES-256-GCM) — 백엔드 ullo/src/common/utils/billing-crypto.util.ts 미러.
 * 백엔드가 암호화해 저장한 member_billing.billing_key 를 배치가 복호화해 청구한다.
 * env BILLING_KEY_ENC_KEY 는 백엔드와 반드시 동일한 값이어야 한다.
 *
 * 저장 포맷: `enc:v1:<iv b64>:<authTag b64>:<ciphertext b64>`
 * 프리픽스 없는 값은 암호화 도입 전 레거시 평문(토스 발급분 포함) — 그대로 반환.
 */
const PREFIX = 'enc:v1:';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

export function encryptBillingKey(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

export function decryptBillingKey(stored: string, secret: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // 레거시 평문
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}
