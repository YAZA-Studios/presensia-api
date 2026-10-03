// ─────────────────────────────────────────────────────────────
// Presensia — klien API pembayaran terpusat yaza-payments.
//
// Semua produk Yaza Studios memakai satu gateway: yaza-payments
// (https://payments.yazastudios.id) yang berbicara langsung dengan
// DOKU (Virtual Account). Presensia TIDAK berbicara langsung ke DOKU.
//
// Autentikasi layanan: Bearer SERVICE_API_KEY (rahasia operator).
// Callback status: yaza-payments mengirim POST dengan header
//   X-Yaza-Timestamp · X-Yaza-Signature · X-Yaza-Event-ID
//   Signature = base64(HMAC-SHA-512(secret, `${time}.${rawBody}`))
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';

const enc = new TextEncoder();

export const YAZA_TENANT_ID = 'presensia';

const b64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Base URL gateway (default domain publik yaza-payments). */
export const yazaUrl = (env: Env): string =>
  (env.YAZA_PAYMENTS_URL || 'https://payments.yazastudios.id').replace(/\/+$/, '');

/** Gateway siap dipakai? Butuh API key layanan. */
export const yazaConfigured = (env: Env): boolean => !!env.YAZA_PAYMENTS_API_KEY;

const authHeaders = (env: Env): Record<string, string> => ({
  Authorization: `Bearer ${env.YAZA_PAYMENTS_API_KEY || ''}`,
  'Content-Type': 'application/json',
});

export interface YazaChannel { id: string; label: string }

/** GET /v1/payment-methods?tenant=presensia — daftar bank VA aktif. */
export const yazaPaymentMethods = async (env: Env): Promise<YazaChannel[]> => {
  try {
    const res = await fetch(`${yazaUrl(env)}/v1/payment-methods?tenant=${YAZA_TENANT_ID}`, {
      method: 'GET', headers: authHeaders(env),
    });
    if (!res.ok) return [];
    const body = await res.json() as { directVa?: { enabled?: boolean; channels?: YazaChannel[] } };
    return body.directVa?.enabled ? (body.directVa.channels ?? []) : [];
  } catch { return []; }
};

export interface YazaPayment {
  transactionId: string;
  externalId: string;
  bankId: string;
  bankLabel: string;
  channel: string;
  virtualAccountNo: string | null;
  amount: number;
  currency: string;
  status: string;
  expiredAt: string;
  howToPayPage?: string;
}

export type YazaCreateOk = { ok: true; payment: YazaPayment; reused: boolean };
export type YazaCreateFail = { ok: false; message: string; status: number };

/** POST /v1/virtual-accounts — buat (atau reuse) VA untuk satu invoice.
 *  Bank dipilih dari env.YAZA_DEFAULT_BANK, atau channel aktif pertama. */
export const yazaCreateVirtualAccount = async (
  env: Env,
  input: { externalId: string; amount: number; expiresAt: string; customer: { name: string; email: string } },
): Promise<YazaCreateOk | YazaCreateFail> => {
  if (!yazaConfigured(env)) {
    return { ok: false, message: 'Gateway yaza-payments belum dikonfigurasi — hubungi admin.', status: 503 };
  }
  const channels = await yazaPaymentMethods(env);
  if (channels.length === 0) {
    return { ok: false, message: 'Belum ada metode pembayaran aktif — hubungi admin.', status: 503 };
  }
  const bankId = (env.YAZA_DEFAULT_BANK || '').trim() || channels[0]!.id;

  let res: Response;
  try {
    res = await fetch(`${yazaUrl(env)}/v1/virtual-accounts`, {
      method: 'POST',
      headers: authHeaders(env),
      body: JSON.stringify({
        tenantId: YAZA_TENANT_ID,
        externalId: input.externalId,
        bankId,
        amount: input.amount,
        expiresAt: input.expiresAt,
        customer: { name: input.customer.name, email: input.customer.email },
      }),
    });
  } catch {
    return { ok: false, message: 'Gagal menghubungi yaza-payments — coba lagi beberapa saat.', status: 502 };
  }
  const raw = await res.text();
  interface YazaCreateBody { error?: string; payment?: YazaPayment; reused?: boolean }
  let parsed: YazaCreateBody | null = null;
  try { parsed = JSON.parse(raw) as YazaCreateBody; } catch { /* biarkan null */ }
  if (!res.ok || !parsed?.payment) {
    return { ok: false, message: (parsed?.error || raw.slice(0, 200) || `Gateway menolak (${res.status}).`).slice(0, 300), status: 502 };
  }
  return { ok: true, payment: parsed.payment, reused: parsed.reused === true };
};

/** Verifikasi callback dari yaza-payments:
 *  base64(HMAC-SHA-512(secret, `${X-Yaza-Timestamp}.${rawBody}`)) == X-Yaza-Signature. */
export const yazaCallbackValid = async (
  env: Env, timestamp: string, signature: string, rawBody: string,
): Promise<boolean> => {
  const secret = (env.YAZA_WEBHOOK_SIGNING_SECRET || '').trim();
  if (!secret || !timestamp || !signature) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const expected = b64(await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${rawBody}`)));
  return safeEqual(expected, signature.replace(/^sha256=|^sha512=/i, '').trim());
};
