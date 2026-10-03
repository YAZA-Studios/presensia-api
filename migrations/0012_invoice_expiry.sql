-- 0012: kedaluwarsa invoice mengikuti masa berlaku Virtual Account.
-- Saat VA expired (gateway menandai transaksi expired), invoice unpaid
-- otomatis menjadi 'expired' — user tinggal memakai tombol Bayar Ulang.
ALTER TABLE invoices ADD COLUMN expires_at TEXT;
