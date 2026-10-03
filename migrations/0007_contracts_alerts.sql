-- Presensia — migrasi alert HR (batch 5)
-- Kontrak karyawan (dasar alert H-60/30/14) + log pengiriman alert
-- agar cron harian tidak mengirim email ganda (idempotent).

ALTER TABLE users ADD COLUMN contract_end_date TEXT;   -- 'YYYY-MM-DD' (PKWT), null = tetap/tanpa kontrak

-- Dedupe pengiriman alert: satu baris = satu alert terkirim.
CREATE TABLE IF NOT EXISTS alert_log (
  org_id TEXT NOT NULL,         -- scope tenant
  kind TEXT NOT NULL,           -- contract-expiry | leave-reminder | leave-digest
  ref TEXT NOT NULL,            -- kontrak: '<email>:H-60' | cuti: '<email>:YYYY-MM' | digest: 'YYYY-MM'
  sent_at TEXT NOT NULL,
  PRIMARY KEY (org_id, kind, ref)
);
