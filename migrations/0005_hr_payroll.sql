-- Presensia — migrasi HR & payroll (batch 3)
-- Cakupan: hari libur, lembur, koreksi absensi self-service,
-- penguncian periode absensi, payroll run + slip gaji.

-- ── Hari libur nasional / cuti bersama per org ────────────────
-- (dipindah dari app_config JSON ke tabel agar bisa dikelola + diaudit)
CREATE TABLE IF NOT EXISTS holidays (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  date TEXT NOT NULL,                          -- 'YYYY-MM-DD'
  name TEXT NOT NULL,
  PRIMARY KEY (org_id, date)
);

-- ── Lembur (SHF-03/04): pengajuan → persetujuan → masuk payroll ──
CREATE TABLE IF NOT EXISTS overtime_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL REFERENCES users(email),
  work_date TEXT NOT NULL,                     -- tanggal lembur
  minutes INTEGER NOT NULL,                    -- durasi diajukan
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ot_org_date ON overtime_requests (org_id, work_date);
CREATE INDEX IF NOT EXISTS idx_ot_email ON overtime_requests (email, work_date);

-- ── Koreksi absensi oleh KARYAWAN (ABS-05, alur self-service) ──
-- Berbeda dari attendance_corrections (append-only audit hasil aksi admin):
-- tabel ini adalah antrean pengajuan yang ditinjau atasan/admin.
CREATE TABLE IF NOT EXISTS attendance_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL REFERENCES users(email),
  work_date TEXT NOT NULL,
  clock_in_at TEXT,                            -- jam benar yang diajukan (opsional)
  clock_out_at TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attreq_org ON attendance_requests (org_id, status);

-- ── Penguncian periode absensi sebelum payroll (ABS-08) ───────
CREATE TABLE IF NOT EXISTS attendance_locks (
  org_id TEXT NOT NULL REFERENCES orgs(id),
  month TEXT NOT NULL,                         -- 'YYYY-MM'
  locked_by TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  PRIMARY KEY (org_id, month)
);

-- ── Payroll run (PAY-02..04): draft → approval → finalized ────
CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  month TEXT NOT NULL,                         -- 'YYYY-MM'
  status TEXT NOT NULL DEFAULT 'draft',        -- draft | finalized
  created_by TEXT NOT NULL,
  finalized_by TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, month)                       -- satu run per bulan (koreksi lewat run baru bila perlu)
);

-- ── Slip gaji per karyawan per run ─────────────────────────────
-- Semua angka rupiah integer. Sumber: timesheet (net/lembur/telat),
-- base salary, approved leaves (potongan absen), approved overtime.
CREATE TABLE IF NOT EXISTS payslips (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL REFERENCES users(email),
  month TEXT NOT NULL,
  base_salary INTEGER NOT NULL DEFAULT 0,
  present_days INTEGER NOT NULL DEFAULT 0,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  overtime_minutes INTEGER NOT NULL DEFAULT 0,
  overtime_pay INTEGER NOT NULL DEFAULT 0,
  absence_deduction INTEGER NOT NULL DEFAULT 0,
  net_pay INTEGER NOT NULL DEFAULT 0,
  detail TEXT,                                 -- JSON rincian (jam kerja, hari absen, dsb.)
  created_at TEXT NOT NULL,
  UNIQUE (run_id, email)
);
CREATE INDEX IF NOT EXISTS idx_payslip_email ON payslips (org_id, email, month);

-- ── Gaji pokok bulanan per karyawan (dasar hitung payroll) ────
ALTER TABLE users ADD COLUMN base_salary INTEGER NOT NULL DEFAULT 0;
