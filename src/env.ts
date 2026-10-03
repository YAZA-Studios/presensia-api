// ─────────────────────────────────────────────────────────────
// Presensia API — tipe lingkungan Cloudflare Workers.
// ─────────────────────────────────────────────────────────────
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;

  APP_NAME: string;
  PUBLIC_API_URL: string;
  PUBLIC_APP_URL: string;

  /**
   * Kredensial DOKU — RAHASIA OPERATOR, diatur via CLI (bukan dari aplikasi):
   *   npx wrangler secret put DOKU_CLIENT_ID
   *   npx wrangler secret put DOKU_SECRET_KEY
   *   npx wrangler secret put DOKU_ENV        # nilai: sandbox | production
   * DOKU_CLIENT_SECRET bersifat opsional (password API dashboard DOKU,
   * hanya untuk endpoint status/status transaksi — bukan alur checkout).
   */
  DOKU_CLIENT_ID: string;
  DOKU_SECRET_KEY: string;
  DOKU_ENV?: string;
  DOKU_CLIENT_SECRET?: string;
  /** Login Google (OAuth 2.0 + OIDC). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /**
   * Brevo (email transaksional) — RAHASIA OPERATOR, diatur via CLI:
   *   npx wrangler secret put BREVO_API_KEY
   *   npx wrangler secret put BREVO_FROM_EMAIL
   *   npx wrangler secret put BREVO_FROM_NAME      # opsional
   * Selama key belum dipasang, pengiriman email di-skip dengan aman (no-op).
   */
  BREVO_API_KEY?: string;
  BREVO_FROM_EMAIL?: string;
  BREVO_FROM_NAME?: string;
  /** Opsional: override secret tanda tangan sesi (rotasi darurat). */
  SESSION_SIGNING_SECRET?: string;
  /**
   * Gateway pembayaran terpusat yaza-payments (semua produk Yaza Studios).
   * RAHASIA OPERATOR, diatur via CLI:
   *   npx wrangler secret put YAZA_PAYMENTS_API_KEY        # SERVICE_API_KEY gateway
   *   npx wrangler secret put YAZA_WEBHOOK_SIGNING_SECRET  # verifikasi callback HMAC
   * Opsional: YAZA_PAYMENTS_URL (default https://payments.yazastudios.id),
   * YAZA_DEFAULT_BANK (id bank_channels; default = channel aktif pertama).
   * Tenant 'presensia' terdaftar di tabel tenants gateway.
   */
  YAZA_PAYMENTS_URL?: string;
  YAZA_PAYMENTS_API_KEY?: string;
  YAZA_WEBHOOK_SIGNING_SECRET?: string;
  YAZA_DEFAULT_BANK?: string;
}
