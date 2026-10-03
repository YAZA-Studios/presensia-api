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
import * as imp from './routes/imports';
import * as bill from './routes/billing';
import * as ana from './routes/analytics';
import * as hr from './routes/hr';
import * as pay from './routes/payroll';
import * as thr from './routes/thr';
import { isPeriodLocked } from './policies';
import { googleStart, googleCallback } from './routes/google';
import { createDelegation, listDelegations, isAdminish } from './authz';
import { getPolicy, mergePolicy, getBpjsConfig, saveBpjsConfig, JKK_RISK_CLASSES, DEFAULT_BPJS_CONFIG, getThrConfig, saveThrConfig, DEFAULT_THR_CONFIG } from './policies';
import { audit } from './audit';
import { computeTimesheet, timesheetCsv } from './timesheet';

type Ctx = { env: Env; claims: SessionClaims; request: Request };

const jsonError = (message: string, status: number): Response => err(message, status);

/** Tempelkan header CORS di satu pintu: semua respons (termasuk error & CSV)
 *  otomatis dapat Allow-Origin yang meng-echo Origin request. */
const withCors = (res: Response, request: Request): Response => {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'private, no-store');
  for (const [k, v] of Object.entries(corsHeaders(request.headers.get('Origin')))) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};

const handle = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  let path = url.pathname.replace(/\/+$/, '') || '/';
  // FE memanggil dengan prefiks /api (VITE_API_URL berakhiran /api; proxy dev juga
  // meneruskan /api) sedangkan route terdaftar tanpa prefiks — normalkan di sini
  // agar /api/register, /api/me, /api/plans, dll. cocok dengan route.
  if (path === '/api' || path.startsWith('/api/')) path = path.slice(4) || '/';
  const method = request.method;

  if (method === 'OPTIONS') return auth.preflight(request);

  // ── Health (publik, untuk uptime monitor) ──
  if (path === '/health') return json({ ok: true, service: 'presensia-api', time: new Date().toISOString() });

  // ── Webhook DOKU (publik, signature-diverifikasi) ──
  if (path === '/payments/doku/notify' && method === 'POST') {
    if (!(await rateLimit(env, `doku:${clientIp(request)}`, 60))) return jsonError('Terlalu sering.', 429);
    return bill.dokuNotify(request, env);
  }

  // ── Auth publik ──
  if (path === '/register' && method === 'POST') return auth.handleRegister(request, env);
  if (path === '/login' && method === 'POST') return auth.handleLogin(request, env);
  if (path === '/logout' && method === 'POST') return auth.handleLogout(request, env);
  if (path === '/auth/exchange' && method === 'POST') return auth.handleExchange(request, env);

  // ── Verifikasi email & reset kata sandi (Brevo; publik, token KV sekali-pakai) ──
  if (path === '/auth/verify-email' && method === 'POST') return auth.handleVerifyEmail(request, env);
  if (path === '/auth/resend-verification' && method === 'POST') return auth.handleResendVerification(request, env);
  if (path === '/auth/forgot-password' && method === 'POST') return auth.handleForgotPassword(request, env);
  if (path === '/auth/reset-password' && method === 'POST') return auth.handleResetPassword(request, env);

  // ── Login Google (OAuth 2.0 + OIDC) ──
  if (path === '/auth/google' && method === 'GET') {
    if (!(await rateLimit(env, `gstart:${clientIp(request)}`, 20))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return googleStart(request, env);
  }
  if (path === '/auth/google/callback' && method === 'GET') return googleCallback(request, env);

  // ── Landing publik: katalog paket ──
  const claims = await sessionFromRequest(env, request);
  if (path === '/plans' && method === 'GET') return bill.publicPlans({ env, claims: claims!, request });

  // ── Rute privat (butuh sesi) ──
  if (!claims) return jsonError('Belum masuk.', 401);
  const ctx: Ctx = { env, claims, request };

  if (path === '/me' && method === 'GET') return auth.handleMe(env, claims);

  // Analitik & ekspor (fitur enterprise)
  if (path === '/analytics/summary' && method === 'GET') return ana.summary(ctx);
  if (path === '/analytics/live' && method === 'GET') return ana.live(ctx);
  if (path === '/analytics/export' && method === 'GET') return ana.exportCsv(request, ctx);

  // Absensi
  if (path === '/sites' && method === 'GET') return att.listSites(ctx);
  if (path === '/sites' && method === 'POST') {
    if (!(await rateLimit(env, `site:${claims.orgId}`, 30))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return att.createSite(request, ctx);
  }
  if (path.startsWith('/sites/') && method === 'DELETE') return att.deleteSite(path.slice('/sites/'.length), ctx);
  if (path === '/shifts' && method === 'GET') return att.listShifts(ctx);
  if (path === '/shifts' && method === 'POST') {
    if (!(await rateLimit(env, `shift:${claims.orgId}`, 30))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return att.createShift(request, ctx);
  }

  // Clock-in/out: rate limit ketat per user.
  if (path === '/attendance/clock' && method === 'POST') {
    if (!(await rateLimit(env, `clock:${claims.email}`, 12))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    const monthNow = new Date().toISOString().slice(0, 7);
    if (await isPeriodLocked(env, claims.orgId, monthNow)) {
      return jsonError('Periode absensi bulan ini sudah dikunci untuk payroll — ajukan koreksi ke atasan Anda.', 409);
    }
    return att.clock(request, ctx);
  }
  if (path === '/attendance/today' && method === 'GET') return att.today(ctx);
  if (path === '/attendance' && method === 'GET') return att.history(request, ctx);
  if (path === '/attendance/challenge' && method === 'POST') {
    if (!(await rateLimit(env, `chal:${claims.email}`, 10))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return att.challenge(ctx);
  }
  if (path.startsWith('/attendance/selfie/') && method === 'GET') return att.selfie(path.slice('/attendance/selfie/'.length), ctx);

  // Koreksi admin (append-only audit) & timesheet payroll
  if (path.startsWith('/attendance/') && path.endsWith('/correct') && method === 'POST') {
    const attId = path.slice('/attendance/'.length, -'/correct'.length);
    const attRow = await env.DB.prepare('SELECT work_date FROM attendance WHERE id = ?1 AND org_id = ?2')
      .bind(attId, claims.orgId).first<{ work_date: string }>();
    if (attRow && await isPeriodLocked(env, claims.orgId, attRow.work_date.slice(0, 7))) {
      return jsonError('Periode bulan data ini sudah dikunci — buka kunci dulu (tercatat di audit).', 409);
    }
    return emp.correctAttendance(request, attId, ctx);
  }
  if (path.startsWith('/attendance/') && path.endsWith('/corrections') && method === 'GET') {
    return emp.listCorrections(path.slice('/attendance/'.length, -'/corrections'.length), ctx);
  }
  if (path === '/timesheet/export' && method === 'GET') {
    if (!isAdminish(claims)) return jsonError('Hanya admin/owner.', 403);
    const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) return jsonError('Format bulan YYYY-MM.', 400);
    const pol = await getPolicy(env, claims.orgId);
    const holCfg = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?1').bind(`holidays:${claims.orgId}`)
      .first<{ value: string }>().catch(() => null);
    const holidays = new Set<string>(holCfg?.value ? (JSON.parse(holCfg.value) as string[]) : []);
    const rows = await env.DB.prepare(
      `SELECT a.work_date, a.clock_in_at, a.clock_out_at, a.status, a.flag, u.name, u.email,
              s.start_time AS shift_start, s.end_time AS shift_end, s.grace_minutes
       FROM attendance a JOIN users u ON u.email = a.email
       LEFT JOIN employee_shifts es ON es.email = a.email AND es.effective_from = (
         SELECT MAX(effective_from) FROM employee_shifts WHERE email = a.email)
       LEFT JOIN shifts s ON s.id = es.shift_id
       WHERE a.org_id = ?1 AND a.work_date LIKE ?2 || '%'
       ORDER BY a.work_date, u.name`
    ).bind(claims.orgId, month).all();
    const sheet = computeTimesheet(rows.results as never[], pol, holidays);
    return new Response(timesheetCsv(sheet), {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="presensia-timesheet-${month}.csv"` },
    });
  }

  // Delegasi wewenang & policy
  if (path === '/delegations' && method === 'GET') return listDelegations(env, claims);
  if (path === '/delegations' && method === 'POST') {
    if (!(await rateLimit(env, `deleg:${claims.orgId}`, 20))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return createDelegation(request, env, claims);
  }
  if (path === '/policy' && method === 'GET') return json({ policy: await getPolicy(env, claims.orgId) });
  if (path === '/policy' && method === 'PUT') {
    if (claims.role === 'employee') return jsonError('Hanya admin/owner.', 403);
    if (!(await rateLimit(env, `policy:${claims.orgId}`, 30))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const next = await mergePolicy(env, claims.orgId, (body || {}) as never);
    return json({ policy: next });
  }

  // ── Konfigurasi BPJS per org (tanpa deploy — app_config) ──
  if (path === '/bpjs-config' && method === 'GET') {
    return json({
      config: await getBpjsConfig(env, claims.orgId),
      defaults: DEFAULT_BPJS_CONFIG,
      jkkClasses: JKK_RISK_CLASSES,
    });
  }
  if (path === '/bpjs-config' && method === 'PUT') {
    if (claims.role === 'employee') return jsonError('Hanya admin/owner.', 403);
    if (!(await rateLimit(env, `bpjs:${claims.orgId}`, 30))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const { config, changed } = await saveBpjsConfig(env, claims.orgId, body || {});
    if (changed) await audit(env, claims.email, 'set-bpjs-config', JSON.stringify(config));
    return json({ config, changed });
  }

  // Karyawan & izin
  if (path === '/employees' && method === 'GET') return emp.list(ctx);
  if (path === '/employees/import/template' && method === 'GET') return imp.importTemplate(ctx);
  if (path === '/employees/import' && method === 'POST') {
    if (!(await rateLimit(env, `empimport:${claims.orgId}`, 5))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return imp.importEmployees(request, ctx);
  }
  if (path === '/employees' && method === 'POST') {
    if (!(await rateLimit(env, `emp:${claims.orgId}`, 20))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return emp.create(request, ctx);
  }
  if (path === '/employees/shift' && method === 'POST') {
    if (!(await rateLimit(env, `empshift:${claims.orgId}`, 30))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return emp.assignShift(request, ctx);
  }
  if (path === '/employees/salary' && method === 'POST') {
    if (!(await rateLimit(env, `empsal:${claims.orgId}`, 30))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return emp.setSalary(request, ctx);
  }
  if (path.startsWith('/employees/') && method === 'DELETE') return emp.remove(path.slice('/employees/'.length), ctx);
  if (path === '/leaves' && method === 'GET') return emp.listLeaves(ctx);
  if (path === '/leaves' && method === 'POST') {
    if (!(await rateLimit(env, `leave:${claims.email}`, 20))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return emp.requestLeave(request, ctx);
  }
  if (path.startsWith('/leaves/') && path.endsWith('/review') && method === 'POST') {
    if (!(await rateLimit(env, `review:${clientIp(request)}`, 60))) return jsonError('Terlalu sering.', 429);
    return emp.reviewLeave(request, path.slice('/leaves/'.length, -'/review'.length), ctx);
  }

  // ── HR: hari libur, saldo cuti, lembur, koreksi self-service ──
  if (path === '/holidays' && method === 'GET') return hr.listHolidays(request, ctx);
  if (path === '/holidays' && method === 'PUT') {
    if (!(await rateLimit(env, `holiday:${claims.orgId}`, 30))) return jsonError('Terlalu sering.', 429);
    return hr.upsertHoliday(request, ctx);
  }
  if (path === '/leaves/balance' && method === 'GET') return hr.leaveBalances(ctx);
  if (path === '/overtime' && method === 'GET') return hr.listOvertime(ctx);
  if (path === '/overtime' && method === 'POST') {
    if (!(await rateLimit(env, `ot:${claims.email}`, 20))) return jsonError('Terlalu sering.', 429);
    return hr.requestOvertime(request, ctx);
  }
  if (path.startsWith('/overtime/') && path.endsWith('/review') && method === 'POST') {
    if (!(await rateLimit(env, `otrev:${clientIp(request)}`, 60))) return jsonError('Terlalu sering.', 429);
    return hr.reviewOvertime(request, path.slice('/overtime/'.length, -'/review'.length), ctx);
  }
  if (path === '/attendance-requests' && method === 'GET') return hr.listAttendanceRequests(ctx);
  if (path === '/attendance-requests' && method === 'POST') {
    if (!(await rateLimit(env, `attreq:${claims.email}`, 20))) return jsonError('Terlalu sering.', 429);
    return hr.requestCorrection(request, ctx);
  }
  if (path.startsWith('/attendance-requests/') && path.endsWith('/review') && method === 'POST') {
    if (!(await rateLimit(env, `attreqrev:${clientIp(request)}`, 60))) return jsonError('Terlalu sering.', 429);
    return hr.reviewCorrection(request, path.slice('/attendance-requests/'.length, -'/review'.length), ctx);
  }

  // ── Payroll: kunci periode, run, slip gaji ──
  if (path === '/attendance-lock' && method === 'GET') return pay.getLock(request, ctx);
  if (path === '/attendance-lock' && method === 'POST') {
    if (!(await rateLimit(env, `attlock:${claims.orgId}`, 20))) return jsonError('Terlalu sering.', 429);
    return pay.setLock(request, ctx);
  }
  if (path === '/payroll/runs' && method === 'GET') return pay.listRuns(ctx);
  if (path === '/payroll/runs' && method === 'POST') {
    if (!(await rateLimit(env, `payrun:${claims.orgId}`, 10))) return jsonError('Terlalu sering.', 429);
    return pay.createRun(request, ctx);
  }
  if (path.startsWith('/payroll/runs/') && path.endsWith('/finalize') && method === 'POST') {
    if (!(await rateLimit(env, `payfin:${claims.orgId}`, 10))) return jsonError('Terlalu sering.', 429);
    return pay.finalizeRun(path.slice('/payroll/runs/'.length, -'/finalize'.length), ctx);
  }
  if (path === '/payroll/payslips' && method === 'GET') return pay.listPayslips(request, ctx);
  if (path === '/payroll/payslips/export' && method === 'GET') return pay.exportPayslips(request, ctx);
  if (path === '/payroll/recap/export' && method === 'GET') return pay.exportRecap(request, ctx);
  if (path === '/payroll/recap/annual' && method === 'GET') return pay.exportRecapAnnual(request, ctx);

  // ── THR tahunan: prorata masa kerja (BR-13) — terpisah dari payroll ──
  if (path === '/thr-config' && method === 'GET') {
    return json({ config: await getThrConfig(env, claims.orgId), defaults: DEFAULT_THR_CONFIG });
  }
  if (path === '/thr-config' && method === 'PUT') {
    if (claims.role === 'employee') return jsonError('Hanya admin/owner.', 403);
    if (!(await rateLimit(env, `thr:${claims.orgId}`, 30))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    const body = await request.json().catch(() => null) as Record<string, unknown> | null;
    const { config, changed } = await saveThrConfig(env, claims.orgId, body || {});
    if (changed) await audit(env, claims.email, 'set-thr-config', JSON.stringify(config));
    return json({ config, changed });
  }
  if (path === '/thr/runs' && method === 'GET') return thr.listRuns(ctx);
  if (path === '/thr/runs' && method === 'POST') {
    if (!(await rateLimit(env, `thrrun:${claims.orgId}`, 10))) return jsonError('Terlalu sering.', 429);
    return thr.createRun(request, ctx);
  }
  if (path === '/thr/runs/export' && method === 'GET') return thr.exportRuns(request, ctx);
  if (path.startsWith('/thr/runs/') && path.endsWith('/finalize') && method === 'POST') {
    if (!(await rateLimit(env, `thrfin:${claims.orgId}`, 10))) return jsonError('Terlalu sering.', 429);
    return thr.finalizeRun(path.slice('/thr/runs/'.length, -'/finalize'.length), ctx);
  }
  if (path.startsWith('/thr/runs/') && method === 'GET') {
    return thr.getRun(path.slice('/thr/runs/'.length), ctx);
  }

  // Tagihan
  if (path === '/billing' && method === 'GET') return bill.myInvoices(ctx);
  if (path === '/billing/invoices' && method === 'POST') {
    if (!(await rateLimit(env, `inv:${claims.orgId}`, 10))) return jsonError('Terlalu sering — tunggu sebentar.', 429);
    return bill.createInvoice(request, ctx);
  }
  if (path.startsWith('/billing/invoices/') && method === 'GET') {
    return bill.invoiceStatus(path.slice('/billing/invoices/'.length), ctx);
  }
  if (path === '/admin/doku' && method === 'GET') return bill.dokuStatus(ctx);

  return jsonError('Endpoint tidak ditemukan.', 404);
};

export default {
  fetch: (request: Request, env: Env): Promise<Response> =>
    handle(request, env)
      .then((res) => withCors(res, request))
      .catch((e) => {
        console.error('[presensia]', e);
        return withCors(jsonError('Kesalahan server.', 500), request);
      }),

  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext): void => {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;

export { corsHeaders };
