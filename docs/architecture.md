# Arsitektur Presensia

Status: adopsi bertahap, 23 September 2026. Acuan konseptual: `arsitektur-tech-saas-cloudflare.md`; keputusan di sini mengikuti kode yang benar-benar tersedia.

## Keputusan deployment

**FE/API terpisah; kandidat monolit pada fase berikutnya.**

React + Vite untuk FE; Worker router manual untuk API; D1, R2, KV dan Cron. Hono terpasang tetapi belum menjadi router aktif.

Repository yang sudah berjalan dipertahankan. Monorepo tidak diperlukan untuk membuat batas domain yang jelas. Penggabungan repository/deployment belum dilakukan; pipeline dan konsumen API harus ikut dimigrasikan bila keputusan itu diambil.

## Struktur yang sudah diterapkan

- UI berada di `presensia-fe`; server berada di `presensia-api`.
- Aturan bisnis murni: `src/domain/attendance/geo.ts` dan `src/domain/identity/session.ts` di repository server.
- Use case session: `src/application/identity/session-service.ts`; kontrak repository dan token codec berada di `src/application/ports/session-repository.ts`.
- Adapter D1: `src/infrastructure/d1/sessions.ts`; token opaque dan SHA-256: `src/infrastructure/crypto/session-token.ts`.
- FE membersihkan QueryClient pada logout/pergantian akun, menghapus cache API legacy, dan memakai NetworkOnly untuk request API/Authorization.
- Entry point lama tetap mengekspor API modul yang sama agar caller dan tes lama tidak terputus.
- `npm run check:domain` pada repository server memeriksa domain dengan TypeScript strict dan hanya library ES2022, tanpa ambient type Workers/Node/browser. Ini pemeriksaan tipe domain, bukan pemeriksa seluruh dependency graph.
- Modul legacy lain belum seluruhnya diekstrak. Tempatkan ekstraksi berikutnya sesuai tanggung jawab saat modul tersebut disentuh.

## Arah dependency

```text
UI -> HTTP API -> route/composition -> application/use case -> domain
                                      |
                                      +-> infrastructure (repository, D1/R2/integrasi)
```

Domain tidak mengimpor Hono, SDK, binding platform atau modul UI. Contracts yang dibagikan ke browser hanya DTO/schema publik, tanpa environment dan secret. Layer application dibuat saat suatu use case benar-benar diekstrak; jangan membuat folder kosong seolah migrasi selesai.

## Tenant dan gap utama

Tenant adalah organisasi. Kode sekarang memakai session opaque dengan hash token di D1, TTL tujuh hari, dan pencabutan saat logout. Setiap request membaca membership, role terbaru dan status organisasi dari primary D1. Foreign key komposit mengikat session ke user dan organisasi. Migrasi `0004_sessions.sql` wajib diterapkan sebelum Worker baru dirilis; token HMAC lama sengaja tidak diterima sehingga pengguna perlu login ulang. Perubahan ini belum diaktifkan di produksi. Admin terpisah juga merupakan konsumen API.

Runbook: `presensia-api/operations/runbooks/session-migration.md` dari root workspace. Tes integrasi menjalankan SQL asli pada SQLite lokal; verifikasi staging Worker tetap diperlukan.

## Adopsi stack rancangan

| Teknologi | Keputusan |
| --- | --- |
| TypeScript strict | Aktif untuk domain yang diekstrak; validasi app/server mengikuti konfigurasi masing-masing. |
| Workers Static Assets | Sudah digunakan monolit Veomoment. FE SSR mempertahankan adapter OpenNext; Presensia masih Pages. |
| Hono | Pertahankan di API yang sudah memakai Hono. Penggantian router manual membutuhkan tes paritas endpoint sebelum diaktifkan. |
| D1 | Sudah dipakai Presensia dan Veomoment. Migrasi Supabase Himpun/Secoret belum dilakukan. |
| R2 | Pertahankan integrasi yang berjalan; metadata dan otorisasi harus tetap di server. |
| KV | Hanya untuk data yang boleh tertinggal; jangan menambahnya jika belum ada kebutuhan cache. |
| Queues + outbox | Belum dipasang. Pilih use case, transaksi outbox, consumer idempotent dan DLQ sebelum provisioning. |
| Session D1/passkeys | Session D1 sudah diimplementasikan di kode dan dites lokal. Passkeys/recovery belum diterapkan; login password/Google tetap digunakan. |
| Workflows/DO | Opsional sesuai kebutuhan. DO venue yang sudah ada tetap dipertahankan. |
| Google/payment gateway | Integrasi eksternal yang masih aktif; runtime belum dapat diklaim sepenuhnya Cloudflare. |

## Syarat sebelum cutover arsitektur

1. Inventaris semua route, konsumen web/mobile/admin, schema, RPC dan integrasi eksternal.
2. Migrasi additive ke staging terisolasi; jangan memakai binding/resource produksi untuk tes.
3. Uji tenant A tidak bisa membaca, mengubah atau menghapus data tenant B; uji role dicabut dan session logout/revoke.
4. Uji API 404 tidak menjadi HTML SPA, cookie/CSRF, akses file privat, webhook duplikat dan job retry.
5. Rekonsiliasi data dan latihan restore; tetapkan periode rollback sebelum menghentikan jalur lama.

Tidak ada deployment atau migrasi data produksi yang dilakukan oleh perubahan struktur ini.

## Referensi

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Routing SPA](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
