// ─────────────────────────────────────────────────────────────
// Presensia — Payroll: kunci periode absensi, payroll run
// (draft → final), dan slip gaji karyawan (PAY-01..05).
// Semua di atas Cloudflare Workers + D1 — tanpa layanan luar.
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err, nowISO, uuid } from '../http';
import { audit } from '../audit';
import { isAdminish } from '../authz';
import { getPolicy, getBpjsConfig } from '../policies';
import { computeTimesheet } from '../timesheet';
import { computePayroll, summarizeEmployee, computeYearEndPph21, computeBpjs, type BpjsConfig, type YearEndResult } from '../domain/payroll/engine';
import { generateAnnualPdf, generateEmployeePdf } from '../payrollPdf';
import type { SessionClaims } from '../sessions';

interface Ctx { env: Env; claims: SessionClaims }

const MONTH_RE = /^\d{4}-\d{2}$/;
const requireAdmin = (claims: SessionClaims): Response | null =>
  claims.role === 'employee' ? err('Hanya admin/owner.', 403) : null;

/** Apakah bulan-bulan absensi sudah dikunci? (dipakai guard modul lain) */
export const isMonthLocked = async (env: Env, orgId: string, month: string): Promise<boolean> => {
  const row = await env.DB.prepare('SELECT org_id FROM attendance_locks WHERE org_id = ?1 AND month = ?2')
    .bind(orgId, month).first();
  return !!row;
};

/** ── Kunci / buka periode absensi (ABS-08) ─────────────────── */

/** GET /attendance-lock?month=YYYY-MM */
export const getLock = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const month = new URL(request.url).searchParams.get('month') || new Date().toISOString().slice(0, 7);
  if (!MONTH_RE.test(month)) return err('Format bulan YYYY-MM.');
  return json({ month, locked: await isMonthLocked(env, claims.orgId, month) });
};

/** POST /attendance-lock — { month, lock } (admin/owner). */
export const setLock = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const body = await request.json().catch(() => null) as { month?: string; lock?: boolean } | null;
  if (!body?.month || !MONTH_RE.test(body.month)) return err('Format bulan YYYY-MM.');
  if (body.lock === false) {
    // Pembukaan kunci dicatat sebagai audit (persistensi perubahan tetap append-only
    // lewat attendance_corrections — lihat reviewCorrection).
    await env.DB.prepare('DELETE FROM attendance_locks WHERE org_id = ?1 AND month = ?2')
      .bind(claims.orgId, body.month).run();
    await audit(env, claims.email, 'unlock-attendance', body.month);
    return json({ ok: true, locked: false });
  }
  await env.DB.prepare(
    `INSERT INTO attendance_locks (org_id, month, locked_by, locked_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(org_id, month) DO NOTHING`
  ).bind(claims.orgId, body.month, claims.email, nowISO()).run();
  await audit(env, claims.email, 'lock-attendance', body.month);
  return json({ ok: true, locked: true });
};

/** ── Payroll run ───────────────────────────────────────────── */

/** GET /payroll/runs — daftar run + ringkasan. */
export const listRuns = async ({ env, claims }: Ctx): Promise<Response> => {
  const rows = await env.DB.prepare(
    `SELECT id, month, status, created_by, finalized_by, finalized_at, created_at,
       (SELECT COUNT(*) FROM payslips p WHERE p.run_id = payroll_runs.id) AS payslip_count,
       (SELECT COALESCE(SUM(p.net_pay), 0) FROM payslips p WHERE p.run_id = payroll_runs.id) AS total_net
     FROM payroll_runs WHERE org_id = ?1 ORDER BY month DESC LIMIT 24`
  ).bind(claims.orgId).all<Record<string, unknown>>();
  return json({ runs: rows.results });
};

/** POST /payroll/runs — { month } → hitung draft dari timesheet.
 *  Wajib: periode absensi dikunci dulu (anti data berubah saat hitung). */
export const createRun = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const body = await request.json().catch(() => null) as { month?: string } | null;
  const month = body?.month || new Date().toISOString().slice(0, 7);
  if (!MONTH_RE.test(month)) return err('Format bulan YYYY-MM.');
  if (!(await isMonthLocked(env, claims.orgId, month))) {
    return err('Kunci periode absensi dulu sebelum menjalankan payroll.', 409);
  }
  const existing = await env.DB.prepare('SELECT id, status FROM payroll_runs WHERE org_id = ?1 AND month = ?2')
    .bind(claims.orgId, month).first<{ id: string; status: string }>();
  if (existing?.status === 'finalized') return err('Payroll bulan ini sudah final — tidak dapat dihitung ulang.', 409);

  const policy = await getPolicy(env, claims.orgId);
  const holCfg = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?1')
    .bind(`holidays:${claims.orgId}`).first<{ value: string }>();
  const holidays = new Set<string>(holCfg?.value ? (JSON.parse(holCfg.value) as string[]) : []);

  const rows = await env.DB.prepare(
    `SELECT a.work_date, a.clock_in_at, a.clock_out_at, a.status, a.flag, u.name, u.email, u.base_salary, u.ptkp,
            s.start_time AS shift_start, s.end_time AS shift_end, s.grace_minutes
     FROM attendance a JOIN users u ON u.email = a.email
     LEFT JOIN employee_shifts es ON es.email = a.email AND es.effective_from = (
       SELECT MAX(effective_from) FROM employee_shifts WHERE email = a.email)
     LEFT JOIN shifts s ON s.id = es.shift_id
     WHERE a.org_id = ?1 AND a.work_date LIKE ?2 || '%'`
  ).bind(claims.orgId, month).all<{
    work_date: string; clock_in_at: string | null; clock_out_at: string | null; status: string;
    flag: string | null; name: string; email: string; base_salary: number; ptkp: string | null;
    shift_start: string | null; shift_end: string | null; grace_minutes: number | null;
  }>();

  // Hari kerja dalam bulan = semua tanggal MINUS hari libur (approval cuti → status leave, bukan absent).
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  let workingDays = daysInMonth;
  const monthPrefix = month;
  for (const h of holidays) {
    if (h.startsWith(monthPrefix)) workingDays -= 1;
  }
  workingDays = Math.max(1, workingDays - countWeekendDays(month));

  // Lembur disetujui per email untuk bulan ini.
  const otRows = await env.DB.prepare(
    `SELECT email, SUM(minutes) AS minutes FROM overtime_requests
     WHERE org_id = ?1 AND status = 'approved' AND work_date LIKE ?2 || '%' GROUP BY email`
  ).bind(claims.orgId, month).all<{ email: string; minutes: number }>();
  const otByEmail = new Map(otRows.results.map((r) => [r.email, r.minutes || 0]));

  // Kelompokkan timesheet per karyawan lalu hitung.
  type Raw = Parameters<typeof computeTimesheet>[0][number];
  const byEmail = new Map<string, { name: string; base: number; ptkp: string; rows: Raw[] }>();
  for (const r of rows.results) {
    if (!r.base_salary || r.base_salary <= 0) continue; // tanpa gaji pokok → tidak dihitung
    const e = byEmail.get(r.email) ?? { name: r.name, base: r.base_salary, ptkp: r.ptkp || 'TK/0', rows: [] as Raw[] };
    e.rows.push(r as unknown as Raw);
    byEmail.set(r.email, e);
  }

  const runId = existing?.id ?? uuid();
  if (!existing) {
    await env.DB.prepare(
      `INSERT INTO payroll_runs (id, org_id, month, status, created_by, created_at) VALUES (?1, ?2, ?3, 'draft', ?4, ?5)`
    ).bind(runId, claims.orgId, month, claims.email, nowISO()).run();
  }

  // Konfigurasi BPJS org (app_config) — tarif/kelas JKK/plafon bisa diubah
  // admin tanpa deploy; snapshot ikut disimpan di detail slip untuk audit.
  const bpjsCfg = await getBpjsConfig(env, claims.orgId);

  let count = 0;
  for (const [email, e] of byEmail) {
    const sheet = computeTimesheet(e.rows as never[], policy, holidays);
    const otMinutes = otByEmail.get(email) ?? 0;
    const input = summarizeEmployee(sheet, otMinutes, workingDays);
    input.baseSalary = e.base;
    input.ptkp = (['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'].includes(e.ptkp)
      ? e.ptkp : 'TK/0') as Parameters<typeof computePayroll>[0]['ptkp'];
    // Pakai multiplier hari-kerja; hari libur sudah dikecualikan dari workingDays.
    input.overtimeMultiplier = policy.overtime.multiplierWeekday;
    input.bpjsConfig = bpjsCfg;
    const result = computePayroll(input);
    const detail: Record<string, unknown> = {
      workingDays,
      holidays: holidays.size,
      overtimeMultiplier: input.overtimeMultiplier,
      hourlyFactor: 173,
      bpjsConfig: bpjsCfg, // snapshot konfigurasi yang dipakai run ini
      lateDays: sheet.filter((s) => s.lateMinutes > 0).length,
      statusBreakdown: sheet.reduce<Record<string, number>>((acc, s) => {
        acc[s.status] = (acc[s.status] ?? 0) + 1; return acc;
      }, {}),
    };
    detail.bpjs = { employee: result.bpjs.employee, company: result.bpjs.company };
    detail.pph21 = { category: result.pph21.category, rate: result.pph21.rate, gross: result.pph21.grossMonthly };
    await env.DB.prepare(
      `INSERT INTO payslips (id, run_id, org_id, email, month, base_salary, present_days, late_minutes,
         overtime_minutes, overtime_pay, absence_deduction, net_pay,
         gross_monthly, pph21, pph21_rate, bpjs_employee, bpjs_company, ptkp, detail, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
       ON CONFLICT(run_id, email) DO UPDATE SET
         base_salary = excluded.base_salary, present_days = excluded.present_days,
         late_minutes = excluded.late_minutes, overtime_minutes = excluded.overtime_minutes,
         overtime_pay = excluded.overtime_pay, absence_deduction = excluded.absence_deduction,
         net_pay = excluded.net_pay, gross_monthly = excluded.gross_monthly,
         pph21 = excluded.pph21, pph21_rate = excluded.pph21_rate,
         bpjs_employee = excluded.bpjs_employee, bpjs_company = excluded.bpjs_company,
         ptkp = excluded.ptkp, detail = excluded.detail`
    ).bind(uuid(), runId, claims.orgId, email, month, result.baseSalary, result.presentDays,
      result.lateMinutes, result.overtimeMinutes, result.overtimePay, result.absenceDeduction,
      result.netPay, result.grossMonthly, result.pph21.tax, result.pph21.rate,
      result.bpjsEmployeeTotal, result.bpjs.company.total, input.ptkp,
      JSON.stringify(detail), nowISO()).run();
    count += 1;
  }

  // ── Masa Pajak Terakhir (Desember): penyesuaian Pasal 17 ──
  // PPh 21 Desember = terutang setahun (tarif Pasal 17 × PKP) − PPh 21
  // Jan–Nov. Hasil bulanan (TER) yang baru dihitung ditimpa dengan selisih
  // ini. Riwayat diambil dari payslips tahun sama (bulan < Desember).
  let yearEnd: { employees: number; incomplete: string[]; totalDue: number } | null = null;
  if (month.slice(5) === '12') {
    yearEnd = await applyYearEndSettlement(env, claims.orgId, runId, month);
    await audit(env, claims.email, 'payroll-year-end',
      `${month} ${yearEnd.employees} slip, total jatuh tempo ${yearEnd.totalDue}${yearEnd.incomplete.length ? `, riwayat tak lengkap: ${yearEnd.incomplete.length}` : ''}`);
  }

  await audit(env, claims.email, 'payroll-run', `${month} ${count} slip`);
  return json({ ok: true, runId, month, payslips: count, workingDays, yearEnd }, existing ? 200 : 201);
};

/** Penyesuaian akhir tahun per slip: timpa pph21/net dengan hitungan
 *  Pasal 17 (bruto setahun − pengurang − PTKP → progresif − Jan–Nov).
 *  Karyawan dengan riwayat < 11 bulan di tahun sama tetap dihitung (masa
 *  sebagian/tahun pajak baru), tapi dilaporkan sebagai `incomplete`. */
const applyYearEndSettlement = async (
  env: Env, orgId: string, runId: string, month: string,
): Promise<{ employees: number; incomplete: string[]; totalDue: number }> => {
  const year = month.slice(0, 4);
  const slips = await env.DB.prepare(
    `SELECT id, email, ptkp, gross_monthly, bpjs_employee, detail
     FROM payslips WHERE org_id = ?1 AND run_id = ?2`
  ).bind(orgId, runId).all<{
    id: string; email: string; ptkp: string | null; gross_monthly: number;
    bpjs_employee: number; detail: string | null;
  }>();

  const incomplete: string[] = [];
  let totalDue = 0;
  const parseDetail = (raw: string | null): Record<string, unknown> => {
    if (!raw) return {};
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  };
  const pensionOf = (detail: Record<string, unknown>): number => {
    const bpjs = detail.bpjs as { employee?: { jht?: number; jp?: number } } | undefined;
    return Math.max(0, Math.round(bpjs?.employee?.jht ?? 0) + Math.round(bpjs?.employee?.jp ?? 0));
  };

  for (const s of slips.results) {
    const hist = await env.DB.prepare(
      `SELECT month, gross_monthly, pph21, detail FROM payslips
       WHERE org_id = ?1 AND email = ?2 AND month LIKE ?3 || '-%' AND month < ?4`
    ).bind(orgId, s.email, year, month).all<{
      month: string; gross_monthly: number; pph21: number; detail: string | null;
    }>();
    if (hist.results.length < 11) incomplete.push(s.email);

    const currentDetail = parseDetail(s.detail);
    const monthlyGross = [...hist.results.map((h) => h.gross_monthly), s.gross_monthly];
    const monthlyPension = [...hist.results.map((h) => pensionOf(parseDetail(h.detail))), pensionOf(currentDetail)];
    const withheldJanNov = hist.results.reduce((a, h) => a + h.pph21, 0);

    const ptkp = (['TK/0', 'TK/1', 'TK/2', 'TK/3', 'K/0', 'K/1', 'K/2', 'K/3'].includes(s.ptkp || '')
      ? s.ptkp! : 'TK/0') as Parameters<typeof computeYearEndPph21>[0]['ptkp'];
    const settlement: YearEndResult = computeYearEndPph21({
      monthlyGross, monthlyEmployeePension: monthlyPension, ptkp, withheldJanNov,
    });

    const decemberGross = Math.max(0, s.gross_monthly);
    const netPay = Math.max(0, decemberGross - settlement.dueDecember - s.bpjs_employee);
    currentDetail.yearEnd = settlement;
    await env.DB.prepare(
      `UPDATE payslips SET pph21 = ?1, pph21_rate = ?2, net_pay = ?3, detail = ?4 WHERE id = ?5`
    ).bind(
      settlement.dueDecember,
      decemberGross > 0 ? settlement.dueDecember / decemberGross : 0,
      netPay, JSON.stringify(currentDetail), s.id,
    ).run();
    totalDue += settlement.dueDecember;
  }
  return { employees: slips.results.length, incomplete, totalDue };
};

const countWeekendDays = (month: string): number => {
  const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
  let n = 0;
  for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow === 0 || dow === 6) n += 1;
  }
  return n;
};

/** POST /payroll/runs/:id/finalize — kunci angka (PAY-04). */
export const finalizeRun = async (id: string, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const run = await env.DB.prepare('SELECT * FROM payroll_runs WHERE id = ?1 AND org_id = ?2')
    .bind(id, claims.orgId).first<{ id: string; month: string; status: string }>();
  if (!run) return err('Payroll run tidak ditemukan.', 404);
  if (run.status === 'finalized') return err('Sudah final.', 409);
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM payslips WHERE run_id = ?1')
    .bind(id).first<{ n: number }>();
  if (!n || n.n === 0) return err('Tidak ada slip — jalankan hitung dulu.', 400);
  await env.DB.prepare(
    "UPDATE payroll_runs SET status = 'finalized', finalized_by = ?1, finalized_at = ?2 WHERE id = ?3"
  ).bind(claims.email, nowISO(), id).run();
  await audit(env, claims.email, 'payroll-finalize', `${run.month} ${id}`);
  return json({ ok: true, status: 'finalized' });
};

/** GET /payroll/payslips?month=YYYY-MM — slip saya (atau org utk admin). */
export const listPayslips = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const month = new URL(request.url).searchParams.get('month') || new Date().toISOString().slice(0, 7);
  if (!MONTH_RE.test(month)) return err('Format bulan YYYY-MM.');
  const rows = isAdminish(claims)
    ? await env.DB.prepare(
        `SELECT p.*, u.name FROM payslips p JOIN users u ON u.email = p.email
         WHERE p.org_id = ?1 AND p.month = ?2 ORDER BY u.name`
      ).bind(claims.orgId, month).all<Record<string, unknown>>()
    : await env.DB.prepare(
        `SELECT p.*, u.name FROM payslips p JOIN users u ON u.email = p.email
         WHERE p.email = ?1 AND p.month = ?2 ORDER BY p.created_at DESC`
      ).bind(claims.email, month).all<Record<string, unknown>>();
  return json({ payslips: rows.results });
};

/** GET /payroll/payslips/export?month=YYYY-MM — CSV untuk bank/akuntansi. */
export const exportPayslips = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  if (!isAdminish(claims)) return err('Hanya admin/owner.', 403);
  const month = new URL(request.url).searchParams.get('month') || new Date().toISOString().slice(0, 7);
  if (!MONTH_RE.test(month)) return err('Format bulan YYYY-MM.');
  const rows = await env.DB.prepare(
    `SELECT p.net_pay, p.base_salary, p.overtime_pay, p.absence_deduction, p.gross_monthly,
            p.pph21, p.pph21_rate, p.bpjs_employee, p.bpjs_company, p.ptkp, u.name, u.email
     FROM payslips p JOIN users u ON u.email = p.email
     WHERE p.org_id = ?1 AND p.month = ?2 ORDER BY u.name`
  ).bind(claims.orgId, month).all<{
    net_pay: number; base_salary: number; overtime_pay: number; absence_deduction: number;
    gross_monthly: number; pph21: number; pph21_rate: number; bpjs_employee: number;
    bpjs_company: number; ptkp: string; name: string; email: string;
  }>();
  const esc = (s: string): string => (s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [
    'name,email,ptkp,base_salary,overtime_pay,absence_deduction,gross_monthly,pph21,pph21_rate,bpjs_employee,bpjs_company,net_pay',
    ...rows.results.map((r) =>
      [esc(r.name), r.email, r.ptkp, r.base_salary, r.overtime_pay, r.absence_deduction,
        r.gross_monthly, r.pph21, r.pph21_rate, r.bpjs_employee, r.bpjs_company, r.net_pay].join(',')),
  ];
  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="payslips-${month}.csv"`,
    },
  });
};

// ── Helper rekap (dipakai lintas jenis laporan) ─────────────────
const parseJson = (raw: string | null): Record<string, unknown> => {
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
};

interface BpjsDetailValues {
  employee: { jht: number; jp: number; jkp: number; kesehatan: number };
  company: { jht: number; jkk: number; jkm: number; jp: number; jkp: number; kesehatan: number };
}

/** Rincian iuran dari snapshot detail.bpjs saat slip dihitung (null = slip lama). */
const bpjsOf = (d: Record<string, unknown>): BpjsDetailValues | null => {
  const b = d.bpjs as {
    employee?: Record<string, number>; company?: Record<string, number>;
  } | undefined;
  if (!b?.employee || !b.company) return null;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    employee: { jht: n(b.employee.jht), jp: n(b.employee.jp), jkp: n(b.employee.jkp), kesehatan: n(b.employee.kesehatan) },
    company: { jht: n(b.company.jht), jkk: n(b.company.jkk), jkm: n(b.company.jkm), jp: n(b.company.jp), jkp: n(b.company.jkp), kesehatan: n(b.company.kesehatan) },
  };
};

/** 'K/2' → 2 tanggungan (SPT Masa). */
const tanggungan = (ptkp: string): number => {
  const m = /^[TK]K\/(\d)$/.exec(ptkp || '');
  return m ? Number(m[1]) : 0;
};

/** Bandingkan snapshot iuran slip dgn config BPJS org yang AKTIF sekarang
 *  (toleransi pembulatan Rp2) — menandai selisih tarif antara keduanya. */
const bandingkanBpjs = (
  baseSalary: number, slip: BpjsDetailValues | null, config: BpjsConfig,
): { status: string; catatan: string } => {
  if (!slip) return { status: 'TANPA SNAPSHOT', catatan: 'slip lama tanpa rincian — hitung ulang payroll' };
  const exp = computeBpjs(baseSalary, config);
  const diffs: string[] = [];
  const cmp = (label: string, actual: number, expected: number): void => {
    if (Math.abs(actual - expected) > 2) diffs.push(`${label}: slip ${actual} vs config ${expected}`);
  };
  cmp('jht_kry', slip.employee.jht, exp.employee.jht);
  cmp('jp_kry', slip.employee.jp, exp.employee.jp);
  cmp('jkp_kry', slip.employee.jkp, exp.employee.jkp);
  cmp('kes_kry', slip.employee.kesehatan, exp.employee.kesehatan);
  cmp('jht_prs', slip.company.jht, exp.company.jht);
  cmp('jkk_prs', slip.company.jkk, exp.company.jkk);
  cmp('jkm_prs', slip.company.jkm, exp.company.jkm);
  cmp('jp_prs', slip.company.jp, exp.company.jp);
  cmp('jkp_prs', slip.company.jkp, exp.company.jkp);
  cmp('kes_prs', slip.company.kesehatan, exp.company.kesehatan);
  return diffs.length ? { status: 'BEDA', catatan: diffs.join('; ') } : { status: 'COCOK', catatan: '' };
};

/** ── Rekap bulanan untuk laporan resmi (dari payslips) ───────────
 *  type=spt  → SPT Masa PPh 21 (form 1721): bruto, DPP, TER, pajak per karyawan.
 *  type=bpjs → Iuran BPJS (JAMSOSTEK + Kesehatan): breakdown JHT/JKK/JKM/JP/JKP
 *              karyawan & perusahaan + baris TOTAL.
 *  Breakdown diambil dari snapshot detail.bpjs saat run dihitung; slip lama
 *  tanpa detail → komponen kosong, total tetap dari kolom payslip. */
export const exportRecap = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  if (!isAdminish(claims)) return err('Hanya admin/owner.', 403);
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
  if (!MONTH_RE.test(month)) return err('Format bulan YYYY-MM.');
  const type = url.searchParams.get('type') === 'bpjs' ? 'bpjs' : 'spt';

  const rows = await env.DB.prepare(
    `SELECT p.base_salary, p.overtime_pay, p.absence_deduction, p.gross_monthly,
            p.pph21, p.pph21_rate, p.bpjs_employee, p.bpjs_company, p.ptkp, p.detail,
            u.name, u.email, u.npwp
     FROM payslips p JOIN users u ON u.email = p.email
     WHERE p.org_id = ?1 AND p.month = ?2 ORDER BY u.name`
  ).bind(claims.orgId, month).all<{
    base_salary: number; overtime_pay: number; absence_deduction: number; gross_monthly: number;
    pph21: number; pph21_rate: number; bpjs_employee: number; bpjs_company: number;
    ptkp: string; detail: string | null; name: string; email: string; npwp: string | null;
  }>();

  const esc = (s: string): string => (s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s);

  if (type === 'spt') {
    let sumBase = 0, sumOt = 0, sumAbs = 0, sumBruto = 0, sumIuran = 0, sumDpp = 0, sumPph = 0;
    const body = rows.results.map((r) => {
      const d = parseJson(r.detail);
      const bpjs = bpjsOf(d);
      const iuran = bpjs ? bpjs.employee.jht + bpjs.employee.jp : 0;
      const pph = (d.pph21 as { gross?: number } | undefined)?.gross;
      const dpp = typeof pph === 'number' ? pph : Math.max(0, r.gross_monthly - iuran);
      const kat = (d.pph21 as { category?: string } | undefined)?.category ?? '';
      sumBase += r.base_salary; sumOt += r.overtime_pay; sumAbs += r.absence_deduction;
      sumBruto += r.gross_monthly; sumIuran += iuran; sumDpp += dpp; sumPph += r.pph21;
      return [month, r.npwp || '', esc(r.name), r.ptkp, tanggungan(r.ptkp), r.base_salary, r.overtime_pay,
        r.absence_deduction, r.gross_monthly, iuran, dpp, kat,
        ((r.pph21_rate ?? 0) * 100).toFixed(2), r.pph21].join(',');
    });
    const lines = [
      'masa_pajak,npwp,nama,status_ptkp,jumlah_tanggungan,gaji_pokok,lembur,potongan_absen,bruto,iuran_jht_jp_karyawan,dpp,kategori_ter,tarif_pph21_persen,pph21',
      ...body,
      ['TOTAL', '', '', '', '', sumBase, sumOt, sumAbs, sumBruto, sumIuran, sumDpp, '', '', sumPph].join(','),
    ];
    return new Response(lines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="rekap-pph21-${month}.csv"`,
      },
    });
  }

  // type=bpjs — JAMSOSTEK (BPJS Ketenagakerjaan) + Kesehatan.
  // Setiap baris divalidasi terhadap config BPJS org yang aktif sekarang:
  // selisih tarif antara snapshot slip & config ditandai di 2 kolom akhir.
  const cfg = await getBpjsConfig(env, claims.orgId);
  const sumKry = { jht: 0, jp: 0, jkp: 0, kesehatan: 0 };
  const sumPrs = { jht: 0, jkk: 0, jkm: 0, jp: 0, jkp: 0, kesehatan: 0 };
  let sumBase = 0, sumTotalKry = 0, sumTotalPrs = 0;
  let bedaCount = 0;
  const body = rows.results.map((r) => {
    const bpjs = bpjsOf(parseJson(r.detail));
    const e = bpjs?.employee ?? { jht: NaN, jp: NaN, jkp: NaN, kesehatan: NaN };
    const c = bpjs?.company ?? { jht: NaN, jkk: NaN, jkm: NaN, jp: NaN, jkp: NaN, kesehatan: NaN };
    for (const k of ['jht', 'jp', 'jkp', 'kesehatan'] as const) sumKry[k] += e[k] || 0;
    for (const k of ['jht', 'jkk', 'jkm', 'jp', 'jkp', 'kesehatan'] as const) sumPrs[k] += c[k] || 0;
    sumBase += r.base_salary; sumTotalKry += r.bpjs_employee; sumTotalPrs += r.bpjs_company;
    const cmp = bandingkanBpjs(r.base_salary, bpjs, cfg);
    if (cmp.status === 'BEDA') bedaCount += 1;
    const num = (v: number): string => (Number.isFinite(v) ? String(v) : '');
    return [month, esc(r.name), r.email, r.base_salary,
      num(e.jht), num(c.jht), num(c.jkk), num(c.jkm), num(e.jp), num(c.jp),
      num(e.jkp), num(c.jkp), num(e.kesehatan), num(c.kesehatan),
      r.bpjs_employee, r.bpjs_company, cmp.status, esc(cmp.catatan)].join(',');
  });
  if (bedaCount > 0) {
    body.push([`# CATATAN: ${bedaCount} slip berbeda dari config BPJS aktif — periksa kolom catatan_selisih`,
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''].join(','));
  }
  const lines = [
    'masa_pajak,nama,email,gaji_pokok,jht_karyawan,jht_perusahaan,jkk_perusahaan,jkm_perusahaan,jp_karyawan,jp_perusahaan,jkp_karyawan,jkp_perusahaan,kesehatan_karyawan,kesehatan_perusahaan,total_karyawan,total_perusahaan,sesuai_config,catatan_selisih',
    ...body,
    ['TOTAL', '', '', sumBase, sumKry.jht, sumPrs.jht, sumPrs.jkk, sumPrs.jkm, sumKry.jp, sumPrs.jp,
      sumKry.jkp, sumPrs.jkp, sumKry.kesehatan, sumPrs.kesehatan, sumTotalKry, sumTotalPrs,
      bedaCount > 0 ? `${bedaCount} BEDA` : 'COCOK', ''].join(','),
  ];
  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="rekap-bpjs-${month}.csv"`,
    },
  });
};

const BULAN = ['jan', 'feb', 'mar', 'apr', 'mei', 'jun', 'jul', 'agu', 'sep', 'okt', 'nov', 'des'] as const;

/** GET /payroll/recap/annual?year=YYYY — rekap tahunan PPh 21 per karyawan
 *  (dasar bukti potong 1721-A1): satu baris per karyawan berisi bruto,
 *  pengurang iuran, PPh 21 per bulan Jan–Des + total setahun.
 *  PPh 21 Desember sudah mencakup penyesuaian Pasal 17 bila dijalankan. */
// ── Segel verifikasi bukti potong 1721-A1 (HMAC per dokumen) ──
/** Kode segel = hex(HMAC-SHA-256(secret, "1721a1|org|email|tahun|total")) 20 digit,
 *  dicetak di PDF dan di-encode ke QR. Secret memakai YAZA_WEBHOOK_SIGNING_SECRET
 *  atau SESSION_SIGNING_SECRET (fallback bawaan) — tanpa secret baru. */
const seal1721Code = async (env: Env, orgId: string, email: string, year: number, total: number): Promise<string> => {
  const secret = (env.YAZA_WEBHOOK_SIGNING_SECRET || env.SESSION_SIGNING_SECRET || 'presensia-1721-seal').trim();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`1721a1|${orgId}|${email.toLowerCase()}|${year}|${Math.round(total)}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 20).replace(/(.{4})(?=.)/g, '$1-');
};
const sealDigits = (code: string): string => code.replace(/[^0-9a-f]/gi, '').toLowerCase();

interface AnnualAggRow {
  name: string; npwp: string; email: string; ptkp: string;
  months: number; bruto: number; pengurang: number;
  monthly: number[]; total: number;
}

/** Agregasi payslips setahun per karyawan (dipakai CSV, PDF, daftar, verify). */
const computeAnnualAggs = async (env: Env, orgId: string, year: number): Promise<AnnualAggRow[]> => {
  const rows = await env.DB.prepare(
    `SELECT p.email, p.month, p.gross_monthly, p.pph21, p.detail, u.name, u.npwp, u.ptkp
     FROM payslips p JOIN users u ON u.email = p.email
     WHERE p.org_id = ?1 AND p.month LIKE ?2 || '-%'
     ORDER BY u.name, p.month`
  ).bind(orgId, String(year)).all<{
    email: string; month: string; gross_monthly: number; pph21: number; detail: string | null;
    name: string; npwp: string | null; ptkp: string | null;
  }>();
  const byEmail = new Map<string, AnnualAggRow>();
  for (const r of rows.results) {
    const m = Number(r.month.slice(5, 7));
    if (!(m >= 1 && m <= 12)) continue;
    const d = parseJson(r.detail);
    const dpp = (d.pph21 as { gross?: number } | undefined)?.gross;
    const pengurang = typeof dpp === 'number' ? Math.max(0, r.gross_monthly - dpp) : 0;
    const a = byEmail.get(r.email) ?? {
      name: r.name, npwp: r.npwp || '', email: r.email, ptkp: r.ptkp || 'TK/0',
      months: 0, bruto: 0, pengurang: 0, monthly: Array(12).fill(0) as number[], total: 0,
    };
    a.months += 1;
    a.bruto += r.gross_monthly;
    a.pengurang += pengurang;
    a.monthly[m - 1] += r.pph21;
    a.total += r.pph21;
    byEmail.set(r.email, a);
  }
  return [...byEmail.values()].sort((x, y) => x.name.localeCompare(y.name));
};

/** GET /payroll/recap/annual/employees?year=YYYY — daftar karyawan berslip
 *  setahun (untuk unduhan PDF bukti potong per orang). */
export const annualEmployees = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  if (!isAdminish(claims)) return err('Hanya admin/owner.', 403);
  const year = Number(new URL(request.url).searchParams.get('year') || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return err('Tahun tidak valid.');
  const aggs = await computeAnnualAggs(env, claims.orgId, year);
  return json({ year, employees: aggs.map(({ email, name, months, bruto, total }) => ({ email, name, months, bruto, total })) });
};

/** Halaman verifikasi publik (dibuka dari QR di PDF) — HTML ringkas. */
const verifyPage = (ok: boolean, title: string, rows: [string, string][]): Response => new Response(
  `<!doctype html><html lang="id"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Bukti Potong 1721-A1 — ${title}</title><style>
 body{font-family:system-ui,-apple-system,sans-serif;background:#F5F8FA;margin:0;padding:32px 16px;color:#152238}
 .card{max-width:460px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 10px 30px rgba(18,60,90,.10)}
 h1{font-size:20px;margin:0 0 4px}.badge{display:inline-block;padding:4px 12px;border-radius:99px;font-size:12px;font-weight:800;margin-bottom:14px}
 .ok{background:#E5F7EC;color:#18803F}.fail{background:#FEECEC;color:#B3222A}
 table{width:100%;border-collapse:collapse;font-size:14px}td{padding:7px 0;border-bottom:1px solid #E3E9F0;vertical-align:top}
 td:first-child{color:#5B6B80;width:44%}td:last-child{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
 .brand{color:#0E7C6C;font-weight:800;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-top:18px}
</style></head><body><div class="card"><h1>${title}</h1>
<span class="badge ${ok ? 'ok' : 'fail'}">${ok ? '✔ Dokumen Sah' : '✖ Gagal Verifikasi'}</span>
<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>
<div class="brand">Presensia · Verifikasi Bukti Potong</div></div></body></html>`,
  { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: ok ? 200 : 400 });

/** GET /payroll/recap/annual/verify?email=&year=&code= — PUBLIK (dari QR).
 *  Hitung ulang segel dari data server dan cocokkan dengan kode di dokumen. */
export const verifyAnnual1721 = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  const year = Number(url.searchParams.get('year') || 0);
  const code = url.searchParams.get('code') || '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !(year >= 2000 && year <= 2100) || !/^[0-9a-f-]{20,24}$/i.test(code)) {
    return verifyPage(false, 'Tidak Terverifikasi', [['Penyebab', 'Parameter tidak valid.']]);
  }
  const user = await env.DB.prepare('SELECT org_id FROM users WHERE email = ?1').bind(email)
    .first<{ org_id: string }>();
  if (!user) return verifyPage(false, 'Tidak Terverifikasi', [['Penyebab', 'Email tidak terdaftar.']]);
  const aggs = await computeAnnualAggs(env, user.org_id, year);
  const agg = aggs.find((a) => a.email === email);
  if (!agg) return verifyPage(false, 'Tidak Terverifikasi', [['Penyebab', 'Tidak ada bukti potong tahun ini untuk email tersebut.']]);
  const expected = await seal1721Code(env, user.org_id, email, year, agg.total);
  if (sealDigits(expected) !== sealDigits(code)) {
    return verifyPage(false, 'Tidak Terverifikasi', [['Penyebab', 'Kode tidak cocok — dokumen mungkin telah dimodifikasi.']]);
  }
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return verifyPage(true, 'Bukti Potong Terverifikasi', [
    ['Nama', esc(agg.name)], ['NPWP', esc(agg.npwp || '—')], ['Email', esc(agg.email)],
    ['Status PTKP', esc(agg.ptkp)], ['Tahun Pajak', String(year)], ['Jumlah Bulan', String(agg.months)],
    ['Bruto Setahun', `Rp ${agg.bruto.toLocaleString('id-ID')}`],
    ['Total PPh 21 Dipotong', `Rp ${agg.total.toLocaleString('id-ID')}`],
  ]);
};

// ── Rekap tahunan PPh 21 (PDF 1721-A1) ──────────────────────
/** GET /payroll/recap/annual/pdf?year=YYYY — PDF bukti potong 1721-A1
 *  per karyawan dari payslips setahun. Worker-generated dengan pdf-lib.
 *  Konten sama dengan CSV rekap tahunan (nama, NPWP, bruto, pengurang,
 *  PPh 21 per bulan Jan–Des, total). */
export const exportRecapAnnualPdf = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  if (!isAdminish(claims)) return err('Hanya admin/owner.', 403);
  const year = Number(new URL(request.url).searchParams.get('year') || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return err('Tahun tidak valid.');

  const rows = await env.DB.prepare(
    `SELECT p.email, p.month, p.gross_monthly, p.pph21, p.detail, u.name, u.npwp, u.ptkp
     FROM payslips p JOIN users u ON u.email = p.email
     WHERE p.org_id = ?1 AND p.month LIKE ?2 || '-%'
     ORDER BY u.name, p.month`
  ).bind(claims.orgId, String(year)).all<{
    email: string; month: string; gross_monthly: number; pph21: number; detail: string | null;
    name: string; npwp: string | null; ptkp: string | null;
  }>();

  interface Agg {
    name: string; npwp: string; email: string; ptkp: string;
    months: number; bruto: number; pengurang: number;
    monthly: number[]; total: number;
  }
  const byEmail = new Map<string, Agg>();
  for (const r of rows.results) {
    const m = Number(r.month.slice(5, 7));
    if (!(m >= 1 && m <= 12)) continue;
    const d = parseJson(r.detail);
    const dpp = (d.pph21 as { gross?: number } | undefined)?.gross;
    const pengurang = typeof dpp === 'number' ? Math.max(0, r.gross_monthly - dpp) : 0;
    const a = byEmail.get(r.email) ?? {
      name: r.name, npwp: r.npwp || '', email: r.email, ptkp: r.ptkp || 'TK/0',
      months: 0, bruto: 0, pengurang: 0, monthly: Array(12).fill(0) as number[], total: 0,
    };
    a.months += 1;
    a.bruto += r.gross_monthly;
    a.pengurang += pengurang;
    a.monthly[m - 1] += r.pph21;
    a.total += r.pph21;
    byEmail.set(r.email, a);
  }
  const aggs = [...byEmail.values()].sort((x, y) => x.name.localeCompare(y.name));

  // ?email= → satu PDF formal per karyawan (QR + segel digital), siap dikirim.
  const reqUrl = new URL(request.url);
  const emailParam = (reqUrl.searchParams.get('email') || '').trim().toLowerCase();
  const issuedAt = new Date().toISOString();
  if (emailParam) {
    const agg = aggs.find((a) => a.email === emailParam);
    if (!agg) return err('Tidak ada payslip tahun itu untuk email ini.', 404);
    const seal = await seal1721Code(env, claims.orgId, agg.email, year, agg.total);
    const base = (env.PUBLIC_API_URL || reqUrl.origin).replace(/\/+$/, '');
    const verifyUrl = `${base}/payroll/recap/annual/verify?email=${encodeURIComponent(agg.email)}&year=${year}&code=${seal}`;
    const pdfBytes = await generateEmployeePdf(claims.orgId, year, agg, { verifyUrl, sealCode: seal, issuedAt });
    return new Response(pdfBytes, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="bukti-potong-1721-A1-${year}-${agg.email}.pdf"`,
      },
    });
  }

  const pdfBytes = await generateAnnualPdf(claims.orgId, year, aggs, issuedAt);
  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="bukti-potong-1721-A1-${year}.pdf"`,
    },
  });
};

/** GET /payroll/recap/bpjs-check?month=YYYY-MM — validasi snapshot iuran slip
 *  vs config BPJS org yang aktif (versi JSON untuk preview UI, logika sama
 *  dengan kolom sesuai_config/catatan_selisih di CSV). Hanya baris bermasalah
 *  yang dikembalikan (BEDA / TANPA SNAPSHOT). */
export const bpjsCheck = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  if (!isAdminish(claims)) return err('Hanya admin/owner.', 403);
  const month = new URL(request.url).searchParams.get('month') || new Date().toISOString().slice(0, 7);
  if (!MONTH_RE.test(month)) return err('Format bulan YYYY-MM.');

  const rows = await env.DB.prepare(
    `SELECT p.base_salary, p.detail, u.name, u.email
     FROM payslips p JOIN users u ON u.email = p.email
     WHERE p.org_id = ?1 AND p.month = ?2 ORDER BY u.name`
  ).bind(claims.orgId, month).all<{
    base_salary: number; detail: string | null; name: string; email: string;
  }>();
  if (rows.results.length === 0) return json({ month, checked: 0, bedaCount: 0, tanpaSnapshot: 0, rows: [] });

  const cfg = await getBpjsConfig(env, claims.orgId);
  let bedaCount = 0, tanpaSnapshot = 0;
  const problems: { email: string; name: string; status: string; catatan: string }[] = [];
  for (const r of rows.results) {
    const cmp = bandingkanBpjs(r.base_salary, bpjsOf(parseJson(r.detail)), cfg);
    if (cmp.status === 'COCOK') continue;
    if (cmp.status === 'BEDA') bedaCount += 1; else tanpaSnapshot += 1;
    problems.push({ email: r.email, name: r.name, status: cmp.status, catatan: cmp.catatan });
  }
  return json({ month, checked: rows.results.length, bedaCount, tanpaSnapshot, rows: problems });
};

export const exportRecapAnnual = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  if (!isAdminish(claims)) return err('Hanya admin/owner.', 403);
  const year = Number(new URL(request.url).searchParams.get('year') || new Date().getFullYear());
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return err('Tahun tidak valid.');

  const rows = await env.DB.prepare(
    `SELECT p.email, p.month, p.gross_monthly, p.pph21, p.detail, u.name, u.npwp, u.ptkp
     FROM payslips p JOIN users u ON u.email = p.email
     WHERE p.org_id = ?1 AND p.month LIKE ?2 || '-%'
     ORDER BY u.name, p.month`
  ).bind(claims.orgId, String(year)).all<{
    email: string; month: string; gross_monthly: number; pph21: number; detail: string | null;
    name: string; npwp: string | null; ptkp: string | null;
  }>();

  interface Agg {
    name: string; npwp: string; email: string; ptkp: string;
    months: number; bruto: number; pengurang: number;
    monthly: number[]; // PPh 21 per bulan (indeks 0 = Jan)
    total: number;
  }
  const byEmail = new Map<string, Agg>();
  for (const r of rows.results) {
    const m = Number(r.month.slice(5, 7));
    if (!(m >= 1 && m <= 12)) continue;
    const d = parseJson(r.detail);
    // Pengurang = bruto − DPP TER (iuran JHT/JP karyawan saat itu).
    const dpp = (d.pph21 as { gross?: number } | undefined)?.gross;
    const pengurang = typeof dpp === 'number' ? Math.max(0, r.gross_monthly - dpp) : 0;
    const a = byEmail.get(r.email) ?? {
      name: r.name, npwp: r.npwp || '', email: r.email, ptkp: r.ptkp || 'TK/0',
      months: 0, bruto: 0, pengurang: 0, monthly: Array(12).fill(0) as number[], total: 0,
    };
    a.months += 1;
    a.bruto += r.gross_monthly;
    a.pengurang += pengurang;
    a.monthly[m - 1] += r.pph21;
    a.total += r.pph21;
    byEmail.set(r.email, a);
  }
  const aggs = [...byEmail.values()].sort((x, y) => x.name.localeCompare(y.name));

  const esc = (s: string): string => (s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s);
  const tot = { bruto: 0, pengurang: 0, monthly: Array(12).fill(0) as number[], total: 0 };
  const body = aggs.map((a) => {
    tot.bruto += a.bruto; tot.pengurang += a.pengurang; tot.total += a.total;
    for (let i = 0; i < 12; i++) tot.monthly[i] += a.monthly[i];
    return [a.npwp, esc(a.name), a.email, a.ptkp, a.months, a.bruto, a.pengurang,
      ...a.monthly, a.total].join(',');
  });
  const lines = [
    `npwp,nama,email,status_ptkp,jumlah_bulan,bruto_setahun,pengurang_iuran,${BULAN.map((b) => `pph21_${b}`).join(',')},total_pph21`,
    ...body,
    ['TOTAL', '', '', '', aggs.length, tot.bruto, tot.pengurang, ...tot.monthly, tot.total].join(','),
  ];
  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="rekap-pph21-tahunan-${year}.csv"`,
    },
  });
};
