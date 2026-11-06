// src/crypto.js 가 만든 형식을 브라우저에서 풉니다: salt | iv | 암호문과 인증 태그
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export async function openSnapshot(sealed, code) {
  const salt = sealed.slice(0, SALT_BYTES);
  const iv = sealed.slice(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, sealed.slice(SALT_BYTES + IV_BYTES));
  return JSON.parse(new TextDecoder().decode(plain));
}
