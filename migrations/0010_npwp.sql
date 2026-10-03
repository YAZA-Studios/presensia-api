-- Presensia — migrasi NPWP karyawan (batch 9)
-- Dipakai rekap SPT Masa PPh 21 & rekap tahunan 1721-A1.
-- Disimpan sebagai digit saja (15 digit format lama / 16 digit format Coretax).

ALTER TABLE users ADD COLUMN npwp TEXT;
