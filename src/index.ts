// ─────────────────────────────────────────────────────────────
// Presensia API — Cloudflare Workers entrypoint.
//
// Stack: Workers + Hono-less manual router (zero-dependency core),
// D1 (SQL), R2 (selfie & bukti bayar), KV (cache/secret/sesi-link),
// Cron (absent otomatis), DOKU Checkout (langganan SaaS).
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';
import { json, err, corsHeaders } from './http';
import { sessionFromRequest, type SessionClaims } from './sessions';
import { rateLimit, clientIp } from './ratelimit';
import { runScheduled } from './cron';
import * as auth from './routes/auth';
import * as att from './routes/attendance';
import * as emp from './routes/employees';
import * as bill from './routes/billing';
import * as ana from './routes/analytics';
import { googleStart, googleCallback } from './routes/google';

type Ctx = { env: Env; claims: SessionClaims; request: Request };

const jsonError = (message: string, status: number): Response => err(message, status);

const handle = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  if (method === 'OPTIONS') return auth.preflight();

  // ── Health (publik, untuk uptime monitor) ──
  if (path === '/health') return json({ ok: true, service: 'presensia-api', time: new Date().toISOString() });

  // ── Webhook DOKU (publik, signature-diverifikasi) ──
  if (path === '/payments/doku/notify' && method === 'POST') return bill.dokuNotify(request, env);

  // ── Auth publik ──
  if (path === '/register' && method === 'POST') return auth.handleRegister(request, env);
  if (path === '/login' && method === 'POST') return auth.handleLogin(request, env);

  // ── Login Google (OAuth 2.0 + OIDC) ──
  if (path === '/auth/google' && method === 'GET') return googleStart(request, env);
  if (path === '/auth/google/callback' && method === 'GET') return googleCallback(request, env);

  // ── Landing publik: katalog paket ──
  const claims = await sessionFromRequest(env, request);
  if (path === '/plans' && method === 'GET') return bill.publicPlans({ env, claims: claims!, request });

  // ── Rute privat (butuh sesi) ──
  if (!claims) return jsonError('Belum masuk.', 401);
  const ctx: Ctx = { env, claims, request };

  if (path === '/me' && method === 'GET') return auth.handleMe(env, claims);
  if (path === '/logout' && method === 'POST') return auth.handleLogout();

  // Analitik & ekspor (fitur enterprise)
  if (path === '/analytics/summary' && method === 'GET') return ana.summary(ctx);
  if (path === '/analytics/live' && method === 'GET') return ana.live(ctx);
  if (path === '/analytics/export' && method === 'GET') return ana.exportCsv(request, ctx);

  // Absensi
  if (path === '/sites' && method === 'GET') return att.listSites(ctx);
  if (path === '/sites' && method === 'POST') return att.createSite(request, ctx);
  if (path.startsWith('/sites/') && method === 'DELETE') return att.deleteSite(path.slice('/sites/'.length), ctx);
  if (path === '/shifts' && method === 'GET') return att.listShifts(ctx);
  if (path === '/shifts' && method === 'POST') return att.createShift(request, ctx);

  // Clock-in/out: rate limit ketat per user.
  if (path === '/attendance/clock' && method === 'POST') {
    if (!(await rateLimit(env, `clock:${claims.email}`, 12))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return att.clock(request, ctx);
  }
  if (path === '/attendance/today' && method === 'GET') return att.today(ctx);
  if (path === '/attendance' && method === 'GET') return att.history(request, ctx);
  if (path.startsWith('/attendance/selfie/') && method === 'GET') return att.selfie(path.slice('/attendance/selfie/'.length), ctx);

  // Karyawan & izin
  if (path === '/employees' && method === 'GET') return emp.list(ctx);
  if (path === '/employees' && method === 'POST') return emp.create(request, ctx);
  if (path.startsWith('/employees/') && method === 'DELETE') return emp.remove(path.slice('/employees/'.length), ctx);
  if (path === '/leaves' && method === 'GET') return emp.listLeaves(ctx);
  if (path === '/leaves' && method === 'POST') return emp.requestLeave(request, ctx);
  if (path.startsWith('/leaves/') && path.endsWith('/review') && method === 'POST') {
    if (!(await rateLimit(env, `review:${clientIp(request)}`, 60))) return jsonError('Terlalu sering.', 429);
    return emp.reviewLeave(request, path.slice('/leaves/'.length, -'/review'.length), ctx);
  }

  // Tagihan
  if (path === '/billing' && method === 'GET') return bill.myInvoices(ctx);
  if (path === '/billing/invoices' && method === 'POST') return bill.createInvoice(request, ctx);
  if (path.startsWith('/billing/invoices/') && method === 'POST' && path.endsWith('/proof')) {
    return bill.uploadProof(request, path.slice('/billing/invoices/'.length, -'/proof'.length), ctx);
  }
  if (path.startsWith('/billing/invoices/') && method === 'GET') {
    return bill.invoiceStatus(path.slice('/billing/invoices/'.length), ctx);
  }
  if (path === '/admin/doku' && method === 'POST') return bill.adminSetDoku(request, ctx);

  return jsonError('Endpoint tidak ditemukan.', 404);
};

export default {
  fetch: (request: Request, env: Env): Promise<Response> =>
    handle(request, env).catch((e) => {
      console.error('[presensia]', e);
      return jsonError('Kesalahan server.', 500);
    }),

  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext): void => {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;

export { corsHeaders };
