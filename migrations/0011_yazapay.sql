-- 0011: integrasi pembayaran terpusat yaza-payments (DOKU Virtual Account).
-- Presensia tidak lagi bicara langsung ke DOKU; invoice menyimpan rujukan
-- VA yang dibuat oleh yaza-payments (ledger pusat semua produk Yaza Studios).
ALTER TABLE invoices ADD COLUMN payment_ref TEXT;      -- transactionId yaza-payments
ALTER TABLE invoices ADD COLUMN va_number TEXT;        -- nomor Virtual Account
ALTER TABLE invoices ADD COLUMN bank_label TEXT;       -- nama bank penerbit VA
ALTER TABLE invoices ADD COLUMN how_to_pay_url TEXT;   -- halaman cara pembayaran
