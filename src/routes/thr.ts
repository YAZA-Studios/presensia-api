// ─────────────────────────────────────────────────────────────
// Presensia — THR (Tunjangan Hari Raya): run tahunan draft → final
// beserta award prorata masa kerja (BR-13 / Permenaker 6/2016).
// THR terpisah dari payroll bulanan — TIDAK butuh kunci absensi.
// Semua di atas Cloudflare Workers + D1 — tanpa layanan luar.
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err, nowISO, uuid } from '../http';
import { audit } from '../audit';
import { isAdminish } from '../authz';
import { getThrConfig } from '../policies';
import { computeThr } from '../domain/payroll/engine';
import type { SessionClaims } from '../sessions';

interface Ctx { env: Env; claims: SessionClaims }

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const requireAdmin = (claims: SessionClaims): Response | null =>
  claims.role === 'employee' ? err('Hanya admin/owner.', 403) : null;

interface AwardView {
  email: string;
  name: string | null;
  hireDate: string | null;
  monthsWorked: number;
  prorataFactor: number;
  eligible: boolean;
  amount: number;
  reason: string | null;
}

const parseDetail = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
};

/** Muat run + award milik org (dipakai create & GET detail). */
const loadRun = async (
  env: Env, orgId: string, runId: string,
): Promise<{ run: Record<string, unknown>; awards: AwardView[] } | null> => {
  const run = await env.DB.prepare(
    `SELECT id, year, ref_date, status, config, total, created_by, finalized_by, finalized_at, created_at
     FROM thr_runs WHERE id = ?1 AND org_id = ?2`
  ).bind(runId, orgId).first<Record<string, unknown>>();
  if (!run) return null;
  const rows = await env.DB.prepare(
    `SELECT a.email, a.hire_date, a.months_worked, a.prorata_factor, a.eligible, a.amount, a.detail, u.name
     FROM thr_awards a LEFT JOIN users u ON u.email = a.email
     WHERE a.run_id = ?1 ORDER BY (a.eligible = 0), u.name, a.email`
  ).bind(runId).all<{
    email: string; hire_date: string | null; months_worked: number; prorata_factor: number;
    eligible: number; amount: number; detail: string | null; name: string | null;
  }>();
  const awards: AwardView[] = rows.results.map((r) => ({
    email: r.email,
    name: r.name,
    hireDate: r.hire_date || null,
    monthsWorked: r.months_worked,
    prorataFactor: r.prorata_factor,
    eligible: r.eligible === 1,
    amount: r.amount,
    reason: (parseDetail(r.detail).reason as string | undefined) ?? null,
  }));
  return { run, awards };
};

/** GET /thr/runs — daftar run THR + ringkasan. */
export const listRuns = async ({ env, claims }: Ctx): Promise<Response> => {
  const rows = await env.DB.prepare(
    `SELECT id, year, ref_date, status, total, created_by, finalized_by, finalized_at, created_at,
       (SELECT COUNT(*) FROM thr_awards a WHERE a.run_id = thr_runs.id) AS award_count,
       (SELECT COUNT(*) FROM thr_awards a WHERE a.run_id = thr_runs.id AND a.eligible = 1) AS eligible_count
     FROM thr_runs WHERE org_id = ?1 ORDER BY year DESC LIMIT 24`
  ).bind(claims.orgId).all<Record<string, unknown>>();
  return json({ runs: rows.results });
};

/** POST /thr/runs — { year?, refDate? } → hitung draft THR (BR-13).
 *  Karyawan: base_salary > 0 (sama dgn payroll — tanpa gaji tak dihitung).
 *  Hitung ulang selama masih draft; run final ditolak (409). */
export const createRun = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const body = await request.json().catch(() => null) as { year?: number; refDate?: string } | null;
  const year = Number(body?.year ?? new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return err('Tahun tidak valid (2000–2100).');
  const refDate = body?.refDate || new Date().toISOString().slice(0, 10);
  if (!dateRe.test(refDate)) return err('Format refDate YYYY-MM-DD.');

  const existing = await env.DB.prepare('SELECT id, status FROM thr_runs WHERE org_id = ?1 AND year = ?2')
    .bind(claims.orgId, year).first<{ id: string; status: string }>();
  if (existing?.status === 'finalized') return err(`THR ${year} sudah final — tidak dapat dihitung ulang.`, 409);

  const config = await getThrConfig(env, claims.orgId);
  const users = await env.DB.prepare(
    'SELECT email, base_salary, hire_date FROM users WHERE org_id = ?1 AND base_salary > 0 ORDER BY email'
  ).bind(claims.orgId).all<{ email: string; base_salary: number; hire_date: string | null }>();

  const runId = existing?.id ?? uuid();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO thr_runs (id, org_id, year, ref_date, status, config, total, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, 'draft', ?5, 0, ?6, ?7)`
    ).bind(runId, claims.orgId, year, refDate, JSON.stringify(config), claims.email, nowISO()).run();
  }
  // Hitung ulang draft → bersihkan award lama dulu (karyawan bisa terhapus).
  await env.DB.prepare('DELETE FROM thr_awards WHERE run_id = ?1').bind(runId).run();

  let total = 0;
  const ineligible: string[] = [];
  for (const u of users.results) {
    const r = computeThr({ baseSalary: u.base_salary, hireDate: u.hire_date, refDate, config });
    if (r.eligible) total += r.amount;
    else ineligible.push(u.email);
    const detail = { reason: r.reason, full: r.full, baseSalary: u.base_salary };
    await env.DB.prepare(
      `INSERT INTO thr_awards (id, run_id, org_id, email, year, hire_date, months_worked,
         prorata_factor, eligible, amount, detail, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`
    ).bind(uuid(), runId, claims.orgId, u.email, year, u.hire_date || null, r.monthsWorked,
      r.prorataFactor, r.eligible ? 1 : 0, r.amount, JSON.stringify(detail), nowISO()).run();
  }
  await env.DB.prepare('UPDATE thr_runs SET ref_date = ?1, config = ?2, total = ?3 WHERE id = ?4')
    .bind(refDate, JSON.stringify(config), total, runId).run();

  const loaded = await loadRun(env, claims.orgId, runId);
  await audit(env, claims.email, 'thr-run',
    `${year} ${users.results.length} karyawan, total ${total}${ineligible.length ? `, ${ineligible.length} tidak berhak` : ''}`);
  return json({
    ok: true, runId, year, refDate,
    count: users.results.length, total, ineligible,
    run: loaded?.run ?? null, awards: loaded?.awards ?? [],
  }, existing ? 200 : 201);
};

/** GET /thr/runs/:id — detail run + seluruh award. */
export const getRun = async (id: string, { env, claims }: Ctx): Promise<Response> => {
  const data = await loadRun(env, claims.orgId, id);
  if (!data) return err('Run THR tidak ditemukan.', 404);
  return json(data);
};

/** POST /thr/runs/:id/finalize — kunci angka THR (BR-13: bayar s/d H-7
 *  sebelum hari raya; setelah final angka tak bisa dihitung ulang). */
export const finalizeRun = async (id: string, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const run = await env.DB.prepare('SELECT id, year, status, total FROM thr_runs WHERE id = ?1 AND org_id = ?2')
    .bind(id, claims.orgId).first<{ id: string; year: number; status: string; total: number }>();
  if (!run) return err('Run THR tidak ditemukan.', 404);
  if (run.status === 'finalized') return err('Sudah final.', 409);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM thr_awards WHERE run_id = ?1')
    .bind(id).first<{ n: number }>();
  if (!n || n.n === 0) return err('Tidak ada award — jalankan hitung dulu.', 400);
  await env.DB.prepare(
    "UPDATE thr_runs SET status = 'finalized', finalized_by = ?1, finalized_at = ?2 WHERE id = ?3"
  ).bind(claims.email, nowISO(), id).run();
  await audit(env, claims.email, 'thr-finalize', `${run.year} ${id} total ${run.total}`);
  return json({ ok: true, status: 'finalized' });
};

/** GET /thr/runs/export?year=YYYY — CSV THR untuk bank/akuntansi. */
export const exportRuns = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  if (!isAdminish(claims)) return err('Hanya admin/owner.', 403);
  const year = Number(new URL(request.url).searchParams.get('year') || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return err('Tahun tidak valid.');
  const run = await env.DB.prepare('SELECT id FROM thr_runs WHERE org_id = ?1 AND year = ?2')
    .bind(claims.orgId, year).first<{ id: string }>();
  if (!run) return err(`Run THR ${year} tidak ditemukan — hitung dulu.`, 404);
  const data = await loadRun(env, claims.orgId, run.id);
  if (!data) return err('Run THR tidak ditemukan.', 404);

  const esc = (s: string): string => (s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [
    'name,email,hire_date,months_worked,prorata_factor,eligible,amount,reason',
    ...(data?.awards ?? []).map((a) =>
      [esc(a.name ?? ''), a.email, a.hireDate ?? '', a.monthsWorked, a.prorataFactor,
        a.eligible ? 1 : 0, a.amount, esc(a.reason ?? '')].join(',')),
  ];
  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="thr-${year}.csv"`,
    },
  });
};
