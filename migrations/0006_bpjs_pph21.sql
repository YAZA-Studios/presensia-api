-- Presensia — migrasi BPJS + PPh 21 (batch 4)
-- Slip gaji kini menyimpan pajak & iuran; users dapat menyimpan status PTKP.

ALTER TABLE payslips ADD COLUMN gross_monthly INTEGER NOT NULL DEFAULT 0;   -- bruto setelah pengurang
ALTER TABLE payslips ADD COLUMN pph21 INTEGER NOT NULL DEFAULT 0;           -- PPh 21 TER dipotong
ALTER TABLE payslips ADD COLUMN pph21_rate REAL NOT NULL DEFAULT 0;         -- tarif TER yang dipakai
ALTER TABLE payslips ADD COLUMN bpjs_employee INTEGER NOT NULL DEFAULT 0;   -- total iuran karyawan
ALTER TABLE payslips ADD COLUMN bpjs_company INTEGER NOT NULL DEFAULT 0;    -- total iuran perusahaan
ALTER TABLE payslips ADD COLUMN ptkp TEXT NOT NULL DEFAULT 'TK/0';          -- status PTKP saat hitung

ALTER TABLE users ADD COLUMN ptkp TEXT NOT NULL DEFAULT 'TK/0';
