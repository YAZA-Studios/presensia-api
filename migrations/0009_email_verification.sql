-- Presensia — migrasi verifikasi email (batch 8)
-- Konfirmasi email untuk pendaftaran mandiri (owner baru) + dasar alur
-- lupa kata sandi. Token verifikasi/reset hidup di KV (bukan DB).

-- 0 = belum terverifikasi (wajib klik tautan aktivasi sebelum login),
-- 1 = terverifikasi.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- Pengguna lama dipercaya: verifikasi hanya diwajibkan untuk pendaftaran
-- mandiri SETELAH fitur ini aktif (anti lockout seluruh basis pengguna).
-- User buatan admin (create/import/Google) juga di-set 1 saat dibuat.
UPDATE users SET email_verified = 1;
