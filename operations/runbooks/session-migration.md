# Rilis session D1 Presensia

Status: implementasi lokal; belum menjalankan migrasi remote atau deploy.

## Perubahan kontrak

Login/register/Google exchange tetap memberikan token dan cookie dengan nama yang sama. Token sekarang opaque `ps1_…`, bukan payload HMAC. Database menyimpan SHA-256 token, expiry dalam Unix milliseconds, dan waktu revoke. Role/org tidak dipercaya dari token. Request membaca membership aktif dan status organisasi dari primary D1; KV tidak menjadi sumber otorisasi.

Token lama tidak diterima. Pengguna web/admin perlu login ulang setelah cutover. Token mentah tetap credential: jangan dicatat ke log. FE saat ini masih mempertahankan bearer token di localStorage untuk kompatibilitas; migrasi cookie-only/CSRF perlu pekerjaan tersendiri.

## Validasi lokal

Gunakan Node 22.13+ (tes memakai `node:sqlite`) dan dependency lock yang tersedia:

```sh
npm ci
npm run typecheck
npm run check:domain
npm run audit:sql
npm test
npx wrangler deploy --dry-run
```

Tes menerapkan migration 0001–0004 ke SQLite memory dengan foreign keys aktif. Mencakup expiry, revocation, tenant palsu, cascade delete, role terkini, suspensi, token rusak dan logout kedua credential. Ini bukan pengganti staging di runtime Workers/D1.

## Urutan cutover

1. Siapkan environment staging dengan DB/KV/R2 dan OAuth callback terpisah. Konfigurasi root saat ini merujuk resource produksi; jangan memakainya untuk eksperimen remote.
2. Periksa ledger migrasi aktual. `0003_suspension.sql` adalah prasyarat; `0004_sessions.sql` additive dan tidak menghapus data. Ambil backup dan verifikasi pemulihan sebelum migrasi produksi.
3. Terapkan migration yang belum diterapkan di staging. Pastikan tabel `sessions`, unique index `(org_id,email)`, foreign key komposit dan indeks expiry tersedia.
4. Deploy Worker D1-session ke staging lalu frontend dengan pembersihan cache. Uji login/register/Google, web/admin, logout (token sebelumnya harus 401), role berubah, organisasi ditangguhkan, tenant A/B, ekspor privat serta Cron. Periksa no-store pada respons API dan cache API legacy sudah terhapus.
5. Setelah staging lulus, terapkan migrasi produksi sebelum Worker baru. Jadwalkan pemberitahuan login ulang. Rilis frontend cache fix; reload tab lama agar service worker terbaru aktif.
6. Pantau error database, 401/5xx, keberhasilan login, cron dan pertumbuhan tabel session. Session expired dibersihkan Cron; revoke tetap ditolak sebelum cleanup.

Tidak ada perintah remote otomatis dalam runbook ini; nama environment dan ledger migrasi harus disesuaikan kondisi deployment aktual.

## Pemulihan

Rollback hanya ke versi yang tetap membaca session D1 dan menghormati revoked_at. Worker HMAC lama dapat menerima token lama yang belum kedaluwarsa dan mengabaikan pencabutan D1, sehingga bukan rollback aman. Jika masalah terjadi, perbaiki versi D1 atau hentikan sementara login/rute privat. Jangan drop tabel session saat Worker masih memakainya. Backup database tidak dengan sendirinya mencabut token; bila perlu lakukan revoke seluruh sesi dengan prosedur operasional yang disetujui.

## Batas yang masih ada

Passkeys, UI daftar perangkat/revoke seluruh sesi, migrasi cookie-only, dan pertukaran kode OAuth atomik belum ditambahkan. Akses data tenant di endpoint lain belum seluruhnya diaudit oleh tes session ini.

Referensi: [D1 primary dan Sessions API](https://developers.cloudflare.com/d1/worker-api/d1-database/).
