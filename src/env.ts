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

  /** Secret DOKU (override); clientId & mode dari app_config. */
  DOKU_SECRET_KEY?: string;
  /** Login Google (OAuth 2.0 + OIDC). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Opsional: override secret tanda tangan sesi (rotasi darurat). */
  SESSION_SIGNING_SECRET?: string;
}
