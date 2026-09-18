// ─────────────────────────────────────────────────────────────
// Presensia — Liveness Challenge (anti foto-layar / titip absen).
//
// Alur:
//   1. Klien minta POST /attendance/challenge → server buat kode acak
//      6 digit + nonce, simpan di KV (TTL 90 detik, sekali pakai).
//   2. Klien menampilkan kode di overlay kamera — user harus membaca
//      kode itu saat selfie (foto lama / screenshot tidak memuat kode).
//   3. Saat clock, klien kirim nonce. Server mencocokkan & membakar
//      nonce (delete). Selfie tanpa challenge valid ditolak.
//
// Catatan jujur: ini challenge-response berbasis konten, bukan ML
// face-depth. Untuk liveness ML (kedipan/depth) → tahap berikutnya
// (postpone: butuh model WASM atau API pihak ketiga).
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';
import { json } from './http';
import type { SessionClaims } from './sessions';

interface Ctx { env: Env; claims: SessionClaims }

const TTL_S = 90;

export const createChallenge = async ({ env, claims }: Ctx): Promise<Response> => {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const nonce = crypto.randomUUID();
  await env.KV.put(`chal:${claims.email}:${nonce}`, code, { expirationTtl: TTL_S });
  return json({ nonce, code, expiresInSeconds: TTL_S });
};

/** Validasi & bakar challenge. Return null = valid; string = pesan error. */
export const consumeChallenge = async (env: Env, email: string, nonce: string | undefined): Promise<string | null> => {
  if (!nonce) return 'Liveness challenge hilang — ambil selfie ulang.';
  const key = `chal:${email}:${nonce}`;
  const code = await env.KV.get(key);
  await env.KV.delete(key); // selalu bakar — sekali pakai
  if (!code) return 'Challenge kedaluwarsa (90 dtk) — ambil selfie ulang.';
  return null;
};
