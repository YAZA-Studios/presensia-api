// ─────────────────────────────────────────────────────────────
// Presensia — Pengiriman email via Brevo (SMTP API v3).
//
// Key BELUM diatur (akan menyusul) — siapkan dulu:
//   npx wrangler secret put BREVO_API_KEY        # key Brevo (v3 SMTP API)
//   npx wrangler secret put BREVO_FROM_EMAIL     # alamat pengirim tervalidasi
//   npx wrangler secret put BREVO_FROM_NAME      # opsional (default: Presensia)
//
// Tanpa key → sendEmail() menjadi no-op yang sukses (logged, tidak error),
// sehingga cron alert tetap aman dijalankan sebelum key dipasang.
// Semua pemanggilan keluar hanya ke api.brevo.com (layanan email — sesuai
// permintaan; tidak menambah cloud selain Cloudflare untuk data/DB).
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** opsional: balasan ke alamat tertentu. */
  replyTo?: string;
}

export interface EmailResult {
  ok: boolean;
  skipped: boolean;   // true = key belum dipasang (bukan kegagalan)
  id?: string;
  error?: string;
}

/** Kirim email via Brevo. Aman dipanggil tanpa key (skip + log). */
export const sendEmail = async (env: Env, msg: EmailMessage): Promise<EmailResult> => {
  const apiKey = env.BREVO_API_KEY;
  const from = env.BREVO_FROM_EMAIL;
  if (!apiKey || !from) {
    console.log(`[email:skip] key/pengirim belum diatur — lewati: to=${msg.to} subj="${msg.subject}"`);
    return { ok: true, skipped: true };
  }
  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: env.BREVO_FROM_NAME || env.APP_NAME || 'Presensia', email: from },
        to: [{ email: msg.to }],
        ...(msg.replyTo ? { replyTo: { email: msg.replyTo } } : {}),
        subject: msg.subject,
        htmlContent: msg.html,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { messageId?: string; code?: string; message?: string };
    if (!res.ok) {
      const error = body.message || body.code || `HTTP ${res.status}`;
      console.error(`[email:fail] ${msg.to} — ${error}`);
      return { ok: false, skipped: false, error };
    }
    return { ok: true, skipped: false, id: body.messageId };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[email:fail] ${msg.to} — ${error}`);
    return { ok: false, skipped: false, error };
  }
};

/** Template HTML dasar — inline style (Brevo mendukung HTML penuh). */
export const emailLayout = (title: string, bodyHtml: string, footerNote = ''): string => `
<!doctype html><html><body style="margin:0;background:#F4F7FA;font-family:Segoe UI,Roboto,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:#fff;border-radius:12px;padding:28px;border:1px solid #E4EAF0;">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#7A8CA0;margin-bottom:4px;">Presensia</div>
      <h1 style="font-size:19px;margin:0 0 14px;color:#16222E;">${title}</h1>
      ${bodyHtml}
      <hr style="border:none;border-top:1px solid #E4EAF0;margin:22px 0 14px;" />
      <p style="font-size:12px;color:#7A8CA0;margin:0;">${footerNote || 'Email ini dikirim otomatis oleh Presensia.'}</p>
    </div>
  </div>
</body></html>`;

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const escapeHtml = esc;
