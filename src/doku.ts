// ─────────────────────────────────────────────────────────────
// Hadirku — integrasi DOKU Checkout (pola teruji veomoment).
//
// Signature (spec resmi DOKU):
//   Digest    = base64(SHA256(raw JSON body))
//   Komponen  = Client-Id / Request-Id / Request-Timestamp /
//               Request-Target / Digest (dipisah \n)
//   Signature = HMACSHA256=base64(HMAC-SHA256(secret, komponen))
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';

const enc = new TextEncoder();

export interface DokuCreds { clientId: string; secretKey: string; envMode: 'sandbox' | 'production' }

export const DOKU_API = {
  sandbox: 'https://api-sandbox.doku.com/checkout/v1/payment',
  production: 'https://api.doku.com/checkout/v1/payment',
} as const;

const b64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

const sha256B64 = async (data: string): Promise<string> =>
  b64(await crypto.subtle.digest('SHA-256', enc.encode(data)));

const hmacB64 = async (secret: string, data: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
};

const signatureComponent = (
  clientId: string, requestId: string, timestamp: string, requestTarget: string, digest: string,
): string =>
  `Client-Id:${clientId}\nRequest-Id:${requestId}\nRequest-Timestamp:${timestamp}\nRequest-Target:${requestTarget}\nDigest:${digest}`;

export const dokuSignature = async (
  clientId: string, requestId: string, timestamp: string, requestTarget: string, bodyJson: string, secretKey: string,
): Promise<string> =>
  `HMACSHA256=${await hmacB64(secretKey, signatureComponent(clientId, requestId, timestamp, requestTarget, await sha256B64(bodyJson)))}`;

const safeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const dokuNotifySignatureValid = async (
  clientId: string, requestId: string, timestamp: string, requestTarget: string, bodyJson: string, secretKey: string, signatureHeader: string,
): Promise<boolean> => {
  const digest = await sha256B64(bodyJson);
  const expected = await hmacB64(secretKey, signatureComponent(clientId, requestId, timestamp, requestTarget, digest));
  const provided = (signatureHeader || '').replace(/^HMACSHA256=/, '').trim();
  return safeEqual(expected, provided);
};

/* ── Kredensial: clientId & mode dari app_config, secret dari Worker secret ── */

export const getDokuCreds = async (env: Env): Promise<DokuCreds | null> => {
  let clientId = '';
  let envMode: 'sandbox' | 'production' = 'sandbox';
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'doku'").first<{ value: string }>();
    if (row?.value) {
      const cfg = JSON.parse(row.value) as { clientId?: string; env?: string };
      clientId = cfg.clientId || '';
      envMode = cfg.env === 'production' ? 'production' : 'sandbox';
    }
  } catch { /* default */ }
  const secretKey = env.DOKU_SECRET_KEY || '';
  if (!clientId || !secretKey) return null;
  return { clientId, secretKey, envMode };
};

export interface DokuCheckoutOk { ok: true; url: string; token: string }
export interface DokuCheckoutFail { ok: false; message: string; status: number }

/** Buat checkout DOKU untuk satu invoice. REUSE link via KV (klik ganda
 *  → DOKU menolak invoice_number duplikat). */
export const createDokuCheckout = async (
  env: Env,
  invoice: { id: string; amount: number },
  opts: { customerEmail: string; customerName: string },
): Promise<DokuCheckoutOk | DokuCheckoutFail> => {
  const creds = await getDokuCreds(env);
  if (!creds) return { ok: false, message: 'Pembayaran DOKU belum dikonfigurasi — hubungi admin.', status: 503 };

  const cacheKey = `dokuurl:${invoice.id}`;
  const cached = await env.KV.get(cacheKey, 'json') as { url: string; token: string } | null;
  if (cached?.url) return { ok: true, url: cached.url, token: cached.token };

  const appBase = (env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
  const notifyBase = (env.PUBLIC_API_URL || appBase).replace(/\/+$/, '');
  const bodyObj = {
    order: {
      amount: invoice.amount,
      invoice_number: invoice.id,
      currency: 'IDR',
      callback_url: `${appBase}/invoice/${encodeURIComponent(invoice.id)}`,
      callback_url_result: `${appBase}/invoice/${encodeURIComponent(invoice.id)}`,
      language: 'ID',
      auto_redirect: true,
    },
    payment: { payment_due_date: 4320 }, // 3 hari
    customer: {
      id: opts.customerEmail.slice(0, 50),
      name: opts.customerName.slice(0, 60),
      email: opts.customerEmail.slice(0, 128),
    },
    ...(notifyBase ? { additional_info: { override_notification_url: `${notifyBase}/payments/doku/notify` } } : {}),
  };
  const bodyJson = JSON.stringify(bodyObj);
  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const requestTarget = '/checkout/v1/payment';
  const digest = await sha256B64(bodyJson);
  const signature = await dokuSignature(creds.clientId, requestId, timestamp, requestTarget, bodyJson, creds.secretKey);

  let res: Response;
  try {
    res = await fetch(DOKU_API[creds.envMode], {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': creds.clientId,
        'Request-Id': requestId,
        'Request-Timestamp': timestamp,
        'Request-Target': requestTarget,
        Digest: digest,
        Signature: signature,
      },
      body: bodyJson,
    });
  } catch {
    return { ok: false, message: 'Gagal menghubungi DOKU — coba lagi atau gunakan transfer manual.', status: 502 };
  }
  const raw = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch { /* null */ }
  if (!res.ok) {
    const msgs = parsed?.error_messages;
    const message = Array.isArray(msgs) && msgs.length ? msgs.join(', ')
      : typeof parsed?.message === 'string' ? parsed.message
      : raw.slice(0, 200) || `DOKU menolak permintaan (${res.status}).`;
    return { ok: false, message: `DOKU: ${message}`.slice(0, 300), status: 502 };
  }
  const url: string | undefined = parsed?.response?.payment?.url;
  const token: string = parsed?.response?.payment?.token_id || '';
  if (!url) return { ok: false, message: 'DOKU tidak mengembalikan URL pembayaran.', status: 502 };
  await env.KV.put(cacheKey, JSON.stringify({ url, token }), { expirationTtl: 60 * 60 * 24 * 4 });
  return { ok: true, url, token };
};
