// ─────────────────────────────────────────────────────────────
// Hadirku — rate limit per-kunci via D1 (jendela 1 menit).
// Disiplin di endpoint sensitif: login, register, clock, bukti bayar.
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';

export const rateLimit = async (env: Env, key: string, maxPerMinute: number): Promise<boolean> => {
  const windowId = Math.floor(Date.now() / 60_000).toString();
  const nowISO = new Date().toISOString();
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limit_hits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
         window_start = ?2`
    ).bind(key, windowId).first<{ count: number }>();
    return (row?.count ?? 1) <= maxPerMinute;
  } catch {
    void nowISO;
    return true; // D1 bermasalah → jangan blokir trafik sah
  }
};

export const clientIp = (request: Request): string =>
  request.headers.get('CF-Connecting-IP') || 'unknown';
