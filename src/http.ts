// ─────────────────────────────────────────────────────────────
// Presensia — util HTTP & CORS.
// ─────────────────────────────────────────────────────────────
/** CORS headers. Origin request di-ECHO persis (bukan wildcard `*`) karena
 *  FE memakai `credentials: 'include'` — browser menolak wildcard untuk
 *  request credentialed. Beri null (curl/server-to-server) → fallback `*`. */
export const corsHeaders = (origin: string | null): Record<string, string> => ({
  'Access-Control-Allow-Origin': origin || '*',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
  'Vary': 'Origin',
});

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', ...extra },
  });

export const err = (message: string, status = 400): Response => json({ error: message }, status);

export const nowISO = (): string => new Date().toISOString();

export const uuid = (): string => crypto.randomUUID();
