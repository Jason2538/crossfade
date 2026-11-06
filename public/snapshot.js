// src/crypto.js 가 만든 형식을 브라우저에서 풉니다: salt | iv | 암호문과 인증 태그
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

// 그룹별 파일 이름입니다. 코드가 없으면 파일 주소를 알 수 없습니다.
export async function groupFileId(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`crossfade-group-v1:${code}`));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

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
