// ─────────────────────────────────────────────────────────────
// Presensia — util HTTP & CORS.
// ─────────────────────────────────────────────────────────────
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export const json = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders, ...extra },
  });

export const err = (message: string, status = 400): Response => json({ error: message }, status);

export const nowISO = (): string => new Date().toISOString();

export const uuid = (): string => crypto.randomUUID();
