import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

// public/snapshot.js 가 브라우저에서 같은 형식을 풉니다. 값을 바꾸면 두 곳을 함께 바꿔야 합니다.
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const deriveKey = (passphrase, salt) => pbkdf2Sync(passphrase, salt, ITERATIONS, 32, 'sha256');

// 형식: salt | iv | 암호문 | 인증 태그
export function sealBytes(plain, passphrase) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  return Buffer.concat([salt, iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

export function openBytes(sealed, passphrase) {
  const salt = sealed.subarray(0, SALT_BYTES);
  const iv = sealed.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(SALT_BYTES + IV_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
}
