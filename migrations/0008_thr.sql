-- Presensia — migrasi THR (batch 7)
-- Tanggal masuk kerja (dasar hitung masa kerja BR-13) + run THR tahunan
-- (draft → final) beserta award per karyawan (prorata masa kerja).

-- Tanggal masuk kerja 'YYYY-MM-DD'; null/kosong = belum diisi
-- (THR tidak dihitung sampai data ini diisi — lihat computeThr).
ALTER TABLE users ADD COLUMN hire_date TEXT;

-- ── THR run tahunan — satu run per tahun (BR-13) ──────────────
-- THR terpisah dari payroll bulanan: TIDAK butuh kunci absensi.
CREATE TABLE IF NOT EXISTS thr_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  year INTEGER NOT NULL,                        -- tahun THR (berjalan)
  ref_date TEXT NOT NULL,                       -- tanggal acuan hitung 'YYYY-MM-DD'
  status TEXT NOT NULL DEFAULT 'draft',         -- draft | finalized
  config TEXT,                                  -- snapshot konfigurasi THR (JSON, BR-24)
  total INTEGER NOT NULL DEFAULT 0,             -- total THR seluruh karyawan (Rp)
  created_by TEXT NOT NULL,
  finalized_by TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, year)                         -- satu run per tahun (hitung ulang selama draft)
);

-- ── THR per karyawan (award) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS thr_awards (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES thr_runs(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  email TEXT NOT NULL REFERENCES users(email),
  year INTEGER NOT NULL,
  hire_date TEXT,                               -- salinan tanggal masuk saat hitung
  months_worked INTEGER NOT NULL DEFAULT 0,     -- masa kerja bulan penuh s/d ref_date
  prorata_factor REAL NOT NULL DEFAULT 0,       -- min(masa kerja, 12) / 12
  eligible INTEGER NOT NULL DEFAULT 0,          -- 1 = berhak THR
  amount INTEGER NOT NULL DEFAULT 0,            -- THR rupiah (dibulatkan)
  detail TEXT,                                  -- JSON: alasan tidak berhak, gaji dasar, dsb.
  created_at TEXT NOT NULL,
  UNIQUE (run_id, email)
);
CREATE INDEX IF NOT EXISTS idx_thr_awards_org ON thr_awards (org_id, year);
