# Presensia API

Backend SaaS absensi karyawan **Presensia** — 100% Cloudflare, tanpa server tradisional.

## Stack Teknologi

| Lapisan | Teknologi |
|---|---|
| Runtime | **Cloudflare Workers** (V8 isolate, edge global) |
| Bahasa | **TypeScript** (strict), router manual zero-dependency |
| Database | **Cloudflare D1** (SQLite terdistribusi) |
| Object storage | **Cloudflare R2** (selfie absensi & bukti transfer — zero egress fee) |
| KV | **Cloudflare Workers KV** (secret sesi, cache link DOKU) |
| Jadwal | **Cron Triggers** (tandai *absent* otomatis, bersih-bersih rate limit) |
| Pembayaran | **DOKU Checkout** (VA/QRIS/e-wallet, signature HMAC-SHA256) |
| Keamanan | PBKDF2-SHA256 300k iterasi, sesi cookie HMAC stateless, rate limit D1, audit log |
| CI/CD | **GitHub Actions** (typecheck + test di setiap push/PR) |

## Fitur

- **Multi-tenant org**: satu org = satu ruang kerja (slug, zona waktu, paket).
- **Clock-in/out** berbasis **GPS + geofencing radius** (haversine server-side) + **selfie wajib** (R2).
- **Shift & toleransi telat**: status `late` dihitung server, bukan klien.
- **Izin/cuti/sakit**: alur ajukan → setujui → absensi otomatis berstatus terkait.
- **Rekap & riwayat bulanan** per karyawan / seluruh org.
- **Langganan SaaS**: trial 14 hari, paket Basic/Pro dinamis dari `app_config`,
  bayar via **DOKU** (aktif otomatis dari notification terverifikasi) atau transfer manual + bukti (R2).
- **Cron**: karyawan tanpa clock-in di akhir hari ditandai `absent` otomatis.

## Endpoint utama

```
GET  /health                       — uptime
POST /register | /login | /logout  — autentikasi
GET  /me                           — profil sesi
GET  /plans                        — katalog paket (publik)

GET/POST/DELETE /sites             — lokasi absen (geofence)
GET/POST /shifts                   — shift & grace
POST /attendance/clock             — clock-in/out (GPS+selfie)
GET  /attendance/today | /attendance?month=YYYY-MM
GET  /attendance/selfie/:id        — aliran selfie dari R2

GET/POST/DELETE /employees         — manajemen karyawan
GET/POST /leaves, POST /leaves/:id/review

GET  /billing, POST /billing/invoices
POST /billing/invoices/:id/proof   — bukti transfer
GET  /billing/invoices/:id         — polling status
POST /payments/doku/notify         — webhook DOKU (signature-diverifikasi)
POST /admin/doku                   — set kredensial gateway (owner)
```

## Menjalankan

```bash
npm install
npx wrangler d1 create presensia-db         # isi database_id di wrangler.jsonc
npx wrangler kv namespace create KV       # isi id KV
npx wrangler r2 bucket create presensia-media
npx wrangler d1 execute presensia-db --remote --file=./migrations/0001_init.sql
npx wrangler secret put DOKU_SECRET_KEY
npm run dev      # lokal
npm run deploy   # produksi
```

Repo FE: `presensia-fe` (React + Vite + TypeScript, deploy Cloudflare Pages/Assets).
