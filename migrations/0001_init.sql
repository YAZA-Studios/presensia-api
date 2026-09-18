-- Presensia — skema awal (D1 / SQLite)

-- ── Org & pengguna ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'trial',          -- trial | basic | pro
  plan_expires_at TEXT,                        -- kedaluwarsa paket (trial 14 hari sejak daftar)
  timezone TEXT NOT NULL DEFAULT 'Asia/Jakarta',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'employee',       -- owner | admin | employee
  password_hash TEXT NOT NULL,
  phone TEXT,
  avatar_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS credentials_v2 (   -- buku besar kredensial (rotasi/audit)
  email TEXT PRIMARY KEY REFERENCES users(email),
  iterations INTEGER NOT NULL,
  salt_b64 TEXT NOT NULL,
  hash_b64 TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ── Lokasi & shift ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_m INTEGER NOT NULL DEFAULT 150,
  address TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  start_time TEXT NOT NULL,                    -- '09:00'
  end_time TEXT NOT NULL,                      -- '17:00'
  grace_minutes INTEGER NOT NULL DEFAULT 15,   -- toleransi telat
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS employee_shifts (  -- penugasan shift per karyawan
  email TEXT NOT NULL REFERENCES users(email),
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  effective_from TEXT NOT NULL,
  PRIMARY KEY (email, effective_from)
);

-- ── Absensi ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL REFERENCES users(email),
  work_date TEXT NOT NULL,                     -- 'YYYY-MM-DD' (zona org)
  clock_in_at TEXT,
  clock_in_lat REAL,
  clock_in_lng REAL,
  clock_in_dist_m REAL,                        -- jarak dari site saat clock-in
  clock_in_selfie_path TEXT,                   -- objek key R2
  clock_out_at TEXT,
  clock_out_lat REAL,
  clock_out_lng REAL,
  clock_out_selfie_path TEXT,
  status TEXT NOT NULL DEFAULT 'present',      -- present | late | absent | leave | sick | holiday
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (email, work_date)
);
CREATE INDEX IF NOT EXISTS idx_att_org_date ON attendance (org_id, work_date);
CREATE INDEX IF NOT EXISTS idx_att_email ON attendance (email, work_date);

CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL REFERENCES users(email),
  type TEXT NOT NULL,                          -- leave | sick | remote
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected
  reviewed_by TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL
);

-- ── Pembayaran (pola veomoment) ───────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,                         -- INV-...
  org_id TEXT NOT NULL REFERENCES orgs(id),
  plan TEXT NOT NULL,                          -- basic | pro
  employee_quota INTEGER NOT NULL,
  months INTEGER NOT NULL DEFAULT 1,
  amount INTEGER NOT NULL,                     -- rupiah bersih (tanpa kode unik)
  status TEXT NOT NULL DEFAULT 'unpaid',       -- unpaid | paid | rejected | cancelled
  method TEXT,                                 -- transfer | doku
  created_at TEXT NOT NULL,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS payment_proofs (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  proof_path TEXT NOT NULL,                    -- R2 object key
  note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | approved | rejected
  reviewed_by TEXT,
  reviewed_at TEXT,
  reject_reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Audit & rate limit ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  key TEXT PRIMARY KEY,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
