// ─────────────────────────────────────────────────────────────
// Presensia — password hashing WebCrypto PBKDF2-SHA256.
// Format self-describing: pbkdf2$<iter>$<saltB64>$<hashB64>
// ─────────────────────────────────────────────────────────────
export const PBKDF2_ITERATIONS = 300_000;

const enc = new TextEncoder();
const toB64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};
const fromB64 = (b64: string): Uint8Array => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

export const validatePassword = (password: string): string | null => {
  if (typeof password !== 'string' || password.length < 8) return 'Kata sandi minimal 8 karakter';
  if (password.length > 128) return 'Kata sandi maksimal 128 karakter';
  return null;
};

const derive = async (password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> => {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
};

export const hashPassword = async (password: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toB64(salt)}$${toB64(bits)}`;
};

export const verifyPassword = async (password: string, stored: string): Promise<boolean> => {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isFinite(iterations) || iterations < 1) return false;
  const salt = fromB64(parts[2]);
  const expected = fromB64(parts[3]);
  const bits = await derive(password, salt, iterations);
  const actual = new Uint8Array(bits);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
};
