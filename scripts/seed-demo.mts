// ─────────────────────────────────────────────────────────────
// Presensia — seed data demo ke D1 LOKAL (.wrangler/state).
// Jalankan:  node scripts/seed-demo.ts
//
// Memakai ENGINE PAYROLL ASLI (computeTimesheet + computePayroll) agar
// payslip, PPh 21 TER, dan BPJS sama persis dengan produksi — sehingga
// preview laporan (SPT Masa, BPJS, 1721-A1, PDF) bisa dicoba end-to-end.
//
// Login demo (FE lokal): owner@demo.id / demo12345
// ─────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../src/passwords.ts';
import { computeTimesheet } from '../src/timesheet.ts';
import { DEFAULT_POLICY } from '../src/policies.ts';
import { computePayroll, summarizeEmployee } from '../src/domain/payroll/engine.ts';
import { DEFAULT_BPJS_CONFIG } from '../src/domain/payroll/bpjs.ts';

const ORG = 'orgdemo0001';
const DB_PATH = process.argv[2]
  ?? '/Users/yahyaz/Documents/Personal/presensia-api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/576f9f754aa76c624a75f1ebeede1e5bd5aa6e2a3669d8c38b72c625026ac17b.sqlite';

const db = new DatabaseSync(DB_PATH);
const cols = (table: string): Set<string> =>
  new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => (c as { name: string }).name));
const insert = (table: string, row: Record<string, unknown>): void => {
  const allowed = cols(table);
  const keys = Object.keys(row).filter((k) => allowed.has(k));
  db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => row[k]));
};

const rand = (n: number): number => Math.floor(Math.random() * n);

// ── 0. Bersihkan data demo lama (idempoten) ──
for (const t of ['payslips', 'payroll_runs', 'attendance', 'attendance_locks', 'overtime_requests', 'leave_requests', 'users', 'sites']) {
  db.prepare(`DELETE FROM ${t} WHERE ${t === 'users' ? 'org_id' : 'org_id'} = ?`).run(ORG);
}
db.prepare('DELETE FROM orgs WHERE id = ?').run(ORG);

// ── 1. Organisasi demo ──
insert('orgs', {
  id: ORG, name: 'Demo Yaza', slug: 'demo-yaza', plan: 'pro', plan_expires_at: '2027-10-03T00:00:00.000Z',
  timezone: 'Asia/Jakarta', policies: JSON.stringify(DEFAULT_POLICY), suspended: 0,
  created_at: new Date().toISOString(),
});

// ── 2. Pengguna (password: demo12345) ──
const pass = await hashPassword('demo12345');
const USERS: { email: string; name: string; role: string; base: number; ptkp: string; hire: string; npwp: string }[] = [
  { email: 'owner@demo.id', name: 'Owner Demo', role: 'owner', base: 10_500_000, ptkp: 'TK/1', hire: '2023-01-02', npwp: '111222334455666' },
  { email: 'budi@demo.id', name: 'Budi Santoso', role: 'manager', base: 8_500_000, ptkp: 'TK/1', hire: '2024-01-15', npwp: '222333444555667' },
  { email: 'siti@demo.id', name: 'Siti Rahma', role: 'admin', base: 7_250_000, ptkp: 'K/1', hire: '2023-03-01', npwp: '333444555666778' },
  { email: 'andi@demo.id', name: 'Andi Pratama', role: 'employee', base: 5_400_000, ptkp: 'TK/0', hire: '2026-05-04', npwp: '444555666777889' },
  { email: 'ratna@demo.id', name: 'Ratna Dewi', role: 'employee', base: 6_800_000, ptkp: 'TK/2', hire: '2026-08-03', npwp: '' },
];
for (const u of USERS) {
  insert('users', {
    email: u.email, org_id: ORG, name: u.name, role: u.role, password_hash: pass,
    base_salary: u.base, ptkp: u.ptkp, hire_date: u.hire, npwp: u.npwp || null,
    email_verified: 1, created_at: new Date().toISOString(),
  });
}

// ── 3. Lokasi absen ──
insert('sites', {
  id: 'sitedemo01', org_id: ORG, name: 'Kantor Pusat', lat: -6.2001, lng: 106.8166,
  radius_m: 150, address: 'Jl. Demo No. 1, Jakarta', created_at: new Date().toISOString(),
});

// ── 4. Cuti disetujui (dikecualikan dari absen otomatis) ──
const LEAVES = [
  { email: 'siti@demo.id', type: 'leave', from: '2026-08-10', to: '2026-08-11' },
  { email: 'ratna@demo.id', type: 'sick', from: '2026-09-14', to: '2026-09-15' },
];
LEAVES.forEach((l, i) => insert('leave_requests', {
  id: `leavedemo0${i + 1}`, org_id: ORG, email: l.email, type: l.type,
  date_from: l.from, date_to: l.to, reason: 'Seed demo', status: 'approved',
  reviewed_by: 'owner@demo.id', created_at: new Date().toISOString(),
}));

// ── 5. Lembur disetujui ──
const OT = [
  { email: 'budi@demo.id', date: '2026-07-24', minutes: 120 },
  { email: 'budi@demo.id', date: '2026-08-14', minutes: 90 },
  { email: 'budi@demo.id', date: '2026-09-12', minutes: 120 },
  { email: 'andi@demo.id', date: '2026-09-26', minutes: 60 },
];
OT.forEach((o, i) => insert('overtime_requests', {
  id: `otdemo000${i + 1}`, org_id: ORG, email: o.email, work_date: o.date,
  minutes: o.minutes, reason: 'Seed demo', status: 'approved',
  reviewed_by: 'owner@demo.id', created_at: new Date().toISOString(),
}));

// ── 6. Absensi 3 bulan (hanya hari kerja, kecuali cuti) ──
db.prepare(`
  INSERT INTO attendance (id, org_id, email, work_date, clock_in_at, clock_out_at, status, note, created_at)
  WITH RECURSIVE seq(d) AS (
    SELECT '2026-07-01' UNION ALL SELECT date(d, '+1 day') FROM seq WHERE d < '2026-10-02'
  )
  SELECT lower(hex(randomblob(16))), ?, u.email, seq.d,
    seq.d || 'T' || CASE WHEN roll <= 11 THEN '01:30' ELSE '01:0' || (abs(random()) % 7 + 1) END || ':00.000Z',
    seq.d || 'T09:15:00.000Z',
    CASE WHEN roll >= 96 THEN 'absent' WHEN roll <= 11 THEN 'late' ELSE 'present' END,
    'seed demo', datetime('now')
  FROM seq JOIN users u ON u.org_id = ?
  JOIN (SELECT d AS dd, (abs(random()) % 100) AS roll FROM seq) r ON r.dd = seq.d
  WHERE strftime('%w', seq.d) IN ('1','2','3','4','5')
    AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.email = u.email AND l.status = 'approved'
                    AND l.date_from <= seq.d AND l.date_to >= seq.d)
    AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.email = u.email AND a.work_date = seq.d)
`).run(ORG, ORG);

// ── 7. Kunci 3 bulan lalu hitung payroll via ENGINE ASLI ──
for (const month of ['2026-07', '2026-08', '2026-09']) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  let workingDays = days;
  for (let d = 1; d <= days; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow === 0 || dow === 6) workingDays -= 1;
  }
  workingDays = Math.max(1, workingDays);

  const runId = crypto.randomUUID();
  insert('payroll_runs', {
    id: runId, org_id: ORG, month, status: 'finalized',
    created_by: 'owner@demo.id', finalized_by: 'owner@demo.id',
    finalized_at: new Date().toISOString(), created_at: new Date().toISOString(),
  });
  db.prepare('INSERT OR REPLACE INTO attendance_locks (org_id, month, locked_by, locked_at) VALUES (?, ?, ?, ?)')
    .run(ORG, month, 'owner@demo.id', new Date().toISOString());

  const att = db.prepare(`
    SELECT a.work_date, a.clock_in_at, a.clock_out_at, a.status, a.flag, u.name, u.email, u.base_salary, u.ptkp
    FROM attendance a JOIN users u ON u.email = a.email
    WHERE a.org_id = ? AND a.work_date LIKE ? || '-%'`).all(ORG, month) as {
    work_date: string; clock_in_at: string | null; clock_out_at: string | null; status: string;
    flag: string | null; name: string; email: string; base_salary: number; ptkp: string;
  }[];
  const otAll = db.prepare(
    `SELECT email, SUM(minutes) AS minutes FROM overtime_requests WHERE org_id = ? AND status = 'approved' AND work_date LIKE ? || '-%' GROUP BY email`,
  ).all(ORG, month) as { email: string; minutes: number }[];
  const otBy = new Map(otAll.map((r) => [r.email, r.minutes || 0]));

  const byEmail = new Map<string, { name: string; base: number; ptkp: string; rows: typeof att }>();
  for (const r of att) {
    if (!r.base_salary || r.base_salary <= 0) continue;
    const e = byEmail.get(r.email) ?? { name: r.name, base: r.base_salary, ptkp: r.ptkp || 'TK/0', rows: [] as typeof att };
    e.rows.push(r);
    byEmail.set(r.email, e);
  }

  let count = 0;
  for (const [email, e] of byEmail) {
    const sheet = computeTimesheet(e.rows, DEFAULT_POLICY, new Set<string>());
    const input = summarizeEmployee(sheet, otBy.get(email) ?? 0, workingDays);
    input.baseSalary = e.base;
    input.ptkp = e.ptkp as never;
    input.overtimeMultiplier = DEFAULT_POLICY.overtime.multiplierWeekday;
    input.bpjsConfig = DEFAULT_BPJS_CONFIG;
    const result = computePayroll(input);
    const detail = {
      workingDays, holidays: 0, overtimeMultiplier: input.overtimeMultiplier, hourlyFactor: 173,
      bpjsConfig: DEFAULT_BPJS_CONFIG,
      lateDays: sheet.filter((s) => s.lateMinutes > 0).length,
      statusBreakdown: sheet.reduce<Record<string, number>>((acc, s) => { acc[s.status] = (acc[s.status] ?? 0) + 1; return acc; }, {}),
      bpjs: { employee: result.bpjs.employee, company: result.bpjs.company },
      pph21: { category: result.pph21.category, rate: result.pph21.rate, gross: result.pph21.grossMonthly },
    };
    insert('payslips', {
      id: crypto.randomUUID(), run_id: runId, org_id: ORG, email, month,
      base_salary: result.baseSalary, present_days: result.presentDays,
      late_minutes: result.lateMinutes, overtime_minutes: result.overtimeMinutes,
      overtime_pay: result.overtimePay, absence_deduction: result.absenceDeduction,
      net_pay: result.netPay, gross_monthly: result.grossMonthly,
      pph21: result.pph21.tax, pph21_rate: result.pph21.rate,
      bpjs_employee: result.bpjsEmployeeTotal, bpjs_company: result.bpjs.company.total,
      ptkp: input.ptkp, detail: JSON.stringify(detail), created_at: new Date().toISOString(),
    });
    count += 1;
  }
  console.log(`Payroll ${month}: ${count} slip (workingDays=${workingDays})`);
}

// ── 8. Ringkasan ──
const sum = (sql: string): unknown => db.prepare(sql).get();
console.log('Ringkasan DB lokal:');
console.log('  orgs    :', sum('SELECT COUNT(*) n FROM orgs'));
console.log('  users   :', sum('SELECT COUNT(*) n FROM users'));
console.log('  absensi :', sum('SELECT COUNT(*) n FROM attendance'));
console.log('  runs    :', sum('SELECT COUNT(*) n FROM payroll_runs'));
console.log('  payslips:', sum('SELECT COUNT(*) n FROM payslips'));
console.log('  net sum :', sum("SELECT printf('%,.0f', SUM(net_pay)) s FROM payslips"));
console.log('Login demo: owner@demo.id / demo12345');
