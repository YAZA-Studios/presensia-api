// ─────────────────────────────────────────────────────────────
// Presensia — Analitik & ekspor (fitur kelas enterprise):
//   • GET /analytics/summary   → KPI hari ini (hadir/telat/absen/izin,
//                                tren 7 hari, top karyawan terlambat)
//   • GET /analytics/export    → CSV rekap bulanan (buka di Excel/Sheets)
//   • GET /analytics/live      → feed kehadiran realtime terbaru
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err } from '../http';
import { workDateIn } from '../geo';
import { audit } from '../audit';
import type { SessionClaims } from '../sessions';

interface Ctx { env: Env; claims: SessionClaims }

const requireAdmin = (claims: SessionClaims): Response | null =>
  claims.role === 'employee' ? err('Hanya admin/owner.', 403) : null;

const esc = (v: unknown): string => {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** GET /analytics/summary — KPI untuk dashboard admin. */
export const summary = async ({ env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const org = await env.DB.prepare('SELECT timezone FROM orgs WHERE id = ?1').bind(claims.orgId)
    .first<{ timezone: string }>();
  const today = workDateIn(org?.timezone || 'Asia/Jakarta');

  const [todayStats, trend, headcount, lateLeaders, sick] = await Promise.all([
    env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM attendance WHERE org_id = ?1 AND work_date = ?2 GROUP BY status`
    ).bind(claims.orgId, today).all<{ status: string; n: number }>(),
    env.DB.prepare(
      `SELECT work_date,
              SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) AS present,
              SUM(CASE WHEN status = 'late' THEN 1 ELSE 0 END) AS late,
              SUM(CASE WHEN status IN ('absent') THEN 1 ELSE 0 END) AS absent
       FROM attendance WHERE org_id = ?1 AND work_date >= date('now', '-6 days')
       GROUP BY work_date ORDER BY work_date`
    ).bind(claims.orgId).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE org_id = ?1").bind(claims.orgId).first<{ n: number }>(),
    env.DB.prepare(
      `SELECT u.name, COUNT(*) AS late_count FROM attendance a JOIN users u ON u.email = a.email
       WHERE a.org_id = ?1 AND a.status = 'late' AND a.work_date >= date('now', '-30 days')
       GROUP BY a.email ORDER BY late_count DESC LIMIT 5`
    ).bind(claims.orgId).all<{ name: string; late_count: number }>(),
    env.DB.prepare(
      `SELECT u.name, a.email, a.work_date FROM attendance a JOIN users u ON u.email = a.email
       WHERE a.org_id = ?1 AND a.status = 'sick' AND a.work_date >= date('now', '-90 days')
       ORDER BY a.email, a.work_date`
    ).bind(claims.orgId).all<{ name: string; email: string; work_date: string }>(),
  ]);

  const byStatus: Record<string, number> = {};
  for (const r of todayStats.results) byStatus[r.status] = r.n;

  // Bradford Factor per karyawan (90 hari): F = S² × D.
  // S = jumlah "spell" (rangkaian hari sakit berurutan dihitung 1), D = total hari sakit.
  const acc = new Map<string, { name: string; spells: number; days: number; last: string }>();
  for (const r of sick.results) {
    const e = acc.get(r.email) ?? { name: r.name, spells: 0, days: 0, last: '' };
    e.days += 1;
    const prev = new Date(`${e.last}T00:00:00Z`);
    const cur = new Date(`${r.work_date}T00:00:00Z`);
    if (!e.last || (cur.getTime() - prev.getTime()) / 86_400_000 > 1) e.spells += 1;
    e.last = r.work_date;
    acc.set(r.email, e);
  }
  const bradford = [...acc.entries()]
    .map(([email, e]) => ({ email, name: e.name, spells: e.spells, days: e.days, score: e.spells * e.spells * e.days }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return json({
    date: today,
    headcount: headcount?.n ?? 0,
    today: {
      present: byStatus.present ?? 0,
      late: byStatus.late ?? 0,
      absent: byStatus.absent ?? 0,
      leave: (byStatus.leave ?? 0) + (byStatus.sick ?? 0),
    },
    trend: trend.results,
    lateLeaders: lateLeaders.results,
    bradford,
  });
};

/** GET /analytics/live — 10 aktivitas kehadiran terbaru (semua karyawan). */
export const live = async ({ env, claims }: Ctx): Promise<Response> => {
  const rows = await env.DB.prepare(
    `SELECT u.name, a.work_date, a.clock_in_at, a.clock_out_at, a.status
     FROM attendance a JOIN users u ON u.email = a.email
     WHERE a.org_id = ?1 AND (a.clock_in_at IS NOT NULL OR a.clock_out_at IS NOT NULL)
     ORDER BY COALESCE(a.clock_out_at, a.clock_in_at) DESC LIMIT 10`
  ).bind(claims.orgId).all<Record<string, unknown>>();
  return json({ activities: rows.results.map((r) => ({
    name: r.name, date: r.work_date, clockInAt: r.clock_in_at, clockOutAt: r.clock_out_at, status: r.status,
  })) });
};

/** GET /analytics/export?month=YYYY-MM — CSV rekap (admin). */
export const exportCsv = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return err('Format bulan YYYY-MM.');

  const rows = await env.DB.prepare(
    `SELECT u.name, u.email, a.work_date, a.clock_in_at, a.clock_out_at, a.status, a.note
     FROM attendance a JOIN users u ON u.email = a.email
     WHERE a.org_id = ?1 AND a.work_date LIKE ?2 || '%'
     ORDER BY a.work_date, u.name`
  ).bind(claims.orgId, month).all<Record<string, unknown>>();

  const lines = ['Nama,Email,Tanggal,Jam Masuk,Jam Keluar,Status,Catatan'];
  for (const r of rows.results) {
    lines.push([r.name, r.email, r.work_date, r.clock_in_at, r.clock_out_at, r.status, r.note].map(esc).join(','));
  }
  await audit(env, claims.email, 'export-csv', `${month} (${rows.results.length} baris)`);
  return new Response(`\uFEFF${lines.join('\n')}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="presensia-rekap-${month}.csv"`,
    },
  });
};
