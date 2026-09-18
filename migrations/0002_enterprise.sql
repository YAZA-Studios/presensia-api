-- Presensia — migrasi fitur enterprise (batch 2)

-- ── Policy engine per org (JSON fleksibel, pola Workday-lite) ──
ALTER TABLE orgs ADD COLUMN policies TEXT;   -- JSON: breakMinutes, overtime:{minMinutes,roundMinutes,multiplier}, leave:{hrApprovalOverDays}, gps:{maxAccuracyM, strictIpCheck}

-- ── RBAC: hierarki manajer ──
ALTER TABLE users ADD COLUMN reports_to TEXT;            -- email atasan langsung (null = admin/owner)
-- role 'manager' = melihat & menyetujui HANYA bawahan reports_to-nya.

-- ── Anti fake-GPS metadata ──
ALTER TABLE attendance ADD COLUMN clock_in_ip TEXT;
ALTER TABLE attendance ADD COLUMN clock_in_acc REAL;     -- akurasi GPS meter (dari device)
ALTER TABLE attendance ADD COLUMN clock_out_ip TEXT;
ALTER TABLE attendance ADD COLUMN clock_out_acc REAL;
ALTER TABLE attendance ADD COLUMN flag TEXT;             -- 'ok' | 'ip-mismatch' | 'low-accuracy'

-- ── Koreksi manual admin (append-only, granular audit) ──
CREATE TABLE IF NOT EXISTS attendance_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attendance_id TEXT NOT NULL REFERENCES attendance(id),
  actor TEXT NOT NULL,
  field TEXT NOT NULL,                        -- clock_in_at | clock_out_at | status
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Append-only: larang UPDATE/DELETE di level aplikasi (tanpa API ubah/hapus).

-- ── Delegasi wewenang approval ──
CREATE TABLE IF NOT EXISTS delegations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  from_email TEXT NOT NULL REFERENCES users(email),
  to_email TEXT NOT NULL REFERENCES users(email),
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

-- ── Approval dua tingkat izin/cuti ──
ALTER TABLE leave_requests ADD COLUMN reviewed_by_2 TEXT;
ALTER TABLE leave_requests ADD COLUMN reviewed_at_2 TEXT;
-- status baru: 'pending_hr' = manager sudah setuju, menunggu HR (cuti > N hari).
