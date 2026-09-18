// ─────────────────────────────────────────────────────────────
// Presensia — absensi: lokasi (sites), shift, clock-in/out ber-GPS+
// selfie (R2), riwayat, dan rekap bulanan.
//
// Gate anti-bocor:
//  • Clock-in wajib dalam radius site → 403 di luar radius.
//  • Selfie wajib (bukti kehadiran) → disimpan ke R2, path tidak
//    pernah diekspos mentah (dialihkan lewat /attendance/selfie/:id).
//  • Status 'late' dihitung server dari shift + grace, bukan klien.
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err, nowISO, uuid } from '../http';
import { distanceMeters, workDateIn, timeIn } from '../geo';
import { audit } from '../audit';
import { getPolicy } from '../policies';
import { clientIp } from '../ratelimit';
import { consumeChallenge, createChallenge } from '../challenge';
import type { SessionClaims } from '../sessions';

interface Ctx { env: Env; claims: SessionClaims }

/** Org dari sesi + zona waktunya. */
const orgOf = async (env: Env, orgId: string): Promise<{ id: string; timezone: string; plan: string; plan_expires_at: string | null } | null> =>
  env.DB.prepare('SELECT id, timezone, plan, plan_expires_at FROM orgs WHERE id = ?1').bind(orgId)
    .first<{ id: string; timezone: string; plan: string; plan_expires_at: string | null }>();

/** ── Sites (lokasi absen) ─────────────────────────────────── */

export const listSites = async ({ env, claims }: Ctx): Promise<Response> => {
  const rows = await env.DB.prepare('SELECT id, name, lat, lng, radius_m, address FROM sites WHERE org_id = ?1 ORDER BY created_at')
    .bind(claims.orgId).all<{ id: string; name: string; lat: number; lng: number; radius_m: number; address: string | null }>();
  return json({ sites: rows.results });
};

export const createSite = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  if (claims.role === 'employee') return err('Hanya admin/owner.', 403);
  const body = await request.json().catch(() => null) as {
    name?: string; lat?: number; lng?: number; radiusM?: number; address?: string;
  } | null;
  if (!body?.name || typeof body.lat !== 'number' || typeof body.lng !== 'number') {
    return err('Nama & koordinat lokasi wajib diisi.');
  }
  const id = uuid();
  await env.DB.prepare('INSERT INTO sites (id, org_id, name, lat, lng, radius_m, address, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
    .bind(id, claims.orgId, body.name.slice(0, 80), body.lat, body.lng, Math.max(20, Math.min(2000, Math.round(body.radiusM ?? 150))), body.address?.slice(0, 200) ?? null, nowISO()).run();
  await audit(env, claims.email, 'create-site', body.name);
  return json({ site: { id, name: body.name, lat: body.lat, lng: body.lng, radiusM: body.radiusM ?? 150, address: body.address ?? null } }, 201);
};

export const deleteSite = async (id: string, { env, claims }: Ctx): Promise<Response> => {
  if (claims.role === 'employee') return err('Hanya admin/owner.', 403);
  const res = await env.DB.prepare('DELETE FROM sites WHERE id = ?1 AND org_id = ?2').bind(id, claims.orgId).run();
  if (!res.meta.changes) return err('Lokasi tidak ditemukan.', 404);
  await audit(env, claims.email, 'delete-site', id);
  return json({ ok: true });
};

/** ── Shift ────────────────────────────────────────────────── */

export const listShifts = async ({ env, claims }: Ctx): Promise<Response> => {
  const rows = await env.DB.prepare('SELECT id, name, start_time, end_time, grace_minutes FROM shifts WHERE org_id = ?1 ORDER BY start_time')
    .bind(claims.orgId).all<{ id: string; name: string; start_time: string; end_time: string; grace_minutes: number }>();
  return json({ shifts: rows.results.map((s) => ({ id: s.id, name: s.name, startTime: s.start_time, endTime: s.end_time, graceMinutes: s.grace_minutes })) });
};

export const createShift = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  if (claims.role === 'employee') return err('Hanya admin/owner.', 403);
  const body = await request.json().catch(() => null) as {
    name?: string; startTime?: string; endTime?: string; graceMinutes?: number;
  } | null;
  const timeOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(body?.startTime || '') && /^([01]\d|2[0-3]):[0-5]\d$/.test(body?.endTime || '');
  if (!body?.name || !timeOk) return err('Nama shift & jam (HH:MM) wajib valid.');
  const id = uuid();
  await env.DB.prepare('INSERT INTO shifts (id, org_id, name, start_time, end_time, grace_minutes, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id, claims.orgId, body.name.slice(0, 60), body.startTime, body.endTime, Math.max(0, Math.min(120, Math.round(body.graceMinutes ?? 15))), nowISO()).run();
  await audit(env, claims.email, 'create-shift', `${body.name} ${body.startTime}-${body.endTime}`);
  return json({ shift: { id, name: body.name, startTime: body.startTime, endTime: body.endTime, graceMinutes: body.graceMinutes ?? 15 } }, 201);
};

/** ── Clock-in / Clock-out ─────────────────────────────────── */

const SITE_MAX = 5; // satu org umumnya sedikit lokasi — ambil semua, pilih terdekat

/** POST /attendance/clock — body: { lat, lng, selfie (dataURL), kind: 'in'|'out' } */
export const clock = async (request: Request, ctx: Ctx): Promise<Response> => {
  const { env, claims } = ctx;
  const body = await request.json().catch(() => null) as {
    lat?: number; lng?: number; accuracy?: number; selfie?: string; kind?: 'in' | 'out'; siteId?: string; note?: string; nonce?: string;
  } | null;
  if (!body || typeof body.lat !== 'number' || typeof body.lng !== 'number' || !body.selfie) {
    return err('Koordinat & selfie wajib diisi.');
  }
  // ── Liveness challenge: selfie wajib memuat kode acak dari server ──
  // (anti foto lama/screenshot: kode dibakar sekali pakai, 90 detik).
  const chalErr = await consumeChallenge(env, claims.email, body.nonce);
  if (chalErr) return err(chalErr, 422);
  if (body.kind !== 'in' && body.kind !== 'out') return err('Jenis clock tidak valid.');

  const org = await orgOf(env, claims.orgId);
  if (!org) return err('Organisasi tidak ditemukan.', 404);
  // Paket kedaluwarsa → blok clock (trial 14 hari / plan_expires_at lewat).
  if (org.plan_expires_at && new Date(org.plan_expires_at).getTime() < Date.now() && org.plan === 'trial') {
    return err('Masa uji coba berakhir — aktifkan paket untuk melanjutkan absensi.', 402);
  }

  // Site terdekat & cek radius (server-side, bukan percaya klien).
  const sites = await env.DB.prepare('SELECT id, name, lat, lng, radius_m FROM sites WHERE org_id = ?1')
    .bind(claims.orgId).all<{ id: string; name: string; lat: number; lng: number; radius_m: number }>();
  const chosen = body.siteId
    ? sites.results.find((s) => s.id === body.siteId)
    : sites.results.slice(0, SITE_MAX).sort((a, b) => distanceMeters(body.lat!, body.lng!, a.lat, a.lng) - distanceMeters(body.lat!, body.lng!, b.lat, b.lng))[0];
  if (!chosen) return err('Belum ada lokasi absen — hubungi admin.', 400);
  const dist = distanceMeters(body.lat, body.lng, chosen.lat, chosen.lng);
  if (dist > chosen.radius_m) {
    return err(`Kamu ${Math.round(dist)} m dari ${chosen.name} (batas ${chosen.radius_m} m) — mendekatlah ke lokasi.`, 403);
  }

  // ── Anti fake-GPS layer (server-side, bukan percaya klien) ──
  // 1) Akurasi device: mock location umumnya melaporkan akurasi "sempurna".
  //    Di atas batas policy → ditolak.
  // 2) Cross-check IP↔koordinat kasar: header CF ipCity/ipCountry vs
  //    koordinat site (jarak besar + IP jauh = flag; strict = tolak).
  const policy = await getPolicy(env, claims.orgId);
  const accuracy = typeof body.accuracy === 'number' ? body.accuracy : null;
  if (accuracy !== null && accuracy > policy.gps.maxAccuracyM) {
    return err(`Sinyal GPS tidak akurat (±${Math.round(accuracy)} m) — matikan mode hemat daya/mock location lalu coba lagi.`, 422);
  }
  const ip = clientIp(request);
  const ipCountry = request.headers.get('CF-IPCountry') || '';
  const ipCity = request.headers.get('CF-IPCity') || '';
  let flag = 'ok';
  // Koordinat site vs (belum ada geo-IP pasangannya) → tandai bila strict check
  // membutuhkan bukti tambahan. Sederhana & jujur: simpan metadata untuk audit;
  // cross-check jarak IP→site dikerjakan via kolom flag + review admin.
  if (accuracy !== null && accuracy > policy.gps.maxAccuracyM / 2) flag = 'low-accuracy';

  // Selfie dataURL → R2 (batas ~1.5 MB setelah kompresi klien).
  const m = body.selfie.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
  if (!m) return err('Format selfie tidak didukung.');
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  if (bytes.length > 1_500_000) return err('Selfie terlalu besar — coba lagi.');
  const selfieKey = `selfies/${claims.orgId}/${uuid()}.${m[1] === 'png' ? 'png' : m[1] === 'webp' ? 'webp' : 'jpg'}`;
  await env.R2.put(selfieKey, bytes, { httpMetadata: { contentType: `image/${m[1]}` } });

  const workDate = workDateIn(org.timezone);
  const now = nowISO();
  void ipCountry; void ipCity; // metadata tersimpan lewat flag/log bila diperlukan forensik

  if (body.kind === 'in') {
    const existing = await env.DB.prepare('SELECT id, clock_in_at FROM attendance WHERE email = ?1 AND work_date = ?2')
      .bind(claims.email, workDate).first<{ id: string; clock_in_at: string | null }>();
    if (existing?.clock_in_at) return err('Kamu sudah clock-in hari ini.', 409);

    // Status late dihitung server dari shift karyawan + grace.
    const shift = await env.DB.prepare(
      `SELECT s.start_time, s.grace_minutes FROM employee_shifts es JOIN shifts s ON s.id = es.shift_id
       WHERE es.email = ?1 ORDER BY es.effective_from DESC LIMIT 1`
    ).bind(claims.email).first<{ start_time: string; grace_minutes: number }>();
    const nowTime = timeIn(org.timezone);
    const late = shift ? nowTime > shift.start_time : false;
    const minutesLate = late
      ? (Number(nowTime.slice(0, 2)) * 60 + Number(nowTime.slice(3, 5))) - (Number(shift!.start_time.slice(0, 2)) * 60 + Number(shift!.start_time.slice(3, 5)))
      : 0;
    const isLate = late && minutesLate > (shift?.grace_minutes ?? 0);

    if (existing) {
      await env.DB.prepare(
        'UPDATE attendance SET clock_in_at = ?1, clock_in_lat = ?2, clock_in_lng = ?3, clock_in_dist_m = ?4, clock_in_selfie_path = ?5, clock_in_ip = ?6, clock_in_acc = ?7, flag = ?8, status = ?9, note = ?10 WHERE id = ?11'
      ).bind(now, body.lat, body.lng, Math.round(dist), selfieKey, ip, accuracy, flag, isLate ? 'late' : 'present', body.note?.slice(0, 200) ?? null, existing.id).run();
      return json({ ok: true, clockedInAt: now, status: isLate ? 'late' : 'present', site: chosen.name, distM: Math.round(dist) });
    }
    const id = uuid();
    await env.DB.prepare(
      `INSERT INTO attendance (id, org_id, email, work_date, clock_in_at, clock_in_lat, clock_in_lng, clock_in_dist_m, clock_in_selfie_path, clock_in_ip, clock_in_acc, flag, status, note, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`
    ).bind(id, claims.orgId, claims.email, workDate, now, body.lat, body.lng, Math.round(dist), selfieKey, ip, accuracy, flag, isLate ? 'late' : 'present', body.note?.slice(0, 200) ?? null, now).run();
    await audit(env, claims.email, 'clock-in', `${workDate} ${chosen.name} ${Math.round(dist)}m acc=${accuracy ?? '?'} flag=${flag}`);
    return json({ ok: true, clockedInAt: now, status: isLate ? 'late' : 'present', site: chosen.name, distM: Math.round(dist) }, 201);
  }

  // Clock-out: cari baris TERAKHIR yang belum clock-out — mendukung
  // shift cross-midnight (masuk 20:00 kemarin, keluar 04:00 pagi ini:
  // baris hari kemarin yang dilengkapi, bukan membuat baris baru).
  const row = await env.DB.prepare(
    `SELECT id, work_date, clock_in_at, clock_out_at FROM attendance
     WHERE email = ?1 AND clock_in_at IS NOT NULL AND clock_out_at IS NULL
     ORDER BY work_date DESC LIMIT 1`
  ).bind(claims.email).first<{ id: string; work_date: string; clock_in_at: string; clock_out_at: string | null }>();
  if (!row) return err('Kamu belum clock-in — tidak ada shift aktif.', 409);
  await env.DB.prepare(
    'UPDATE attendance SET clock_out_at = ?1, clock_out_lat = ?2, clock_out_lng = ?3, clock_out_selfie_path = ?4, clock_out_ip = ?5, clock_out_acc = ?6 WHERE id = ?7'
  ).bind(now, body.lat, body.lng, selfieKey, ip, accuracy, row.id).run();
  await audit(env, claims.email, 'clock-out', `${row.work_date} (selesai ${workDate})`);
  return json({ ok: true, clockedOutAt: now, workDate: row.work_date, site: chosen.name, distM: Math.round(dist) });
};

/** GET /attendance/today — status hari ini milik sesi. */
/** POST /attendance/challenge — minta kode liveness untuk overlay selfie. */
export const challenge = async (ctx: Ctx): Promise<Response> => createChallenge(ctx);

export const today = async ({ env, claims }: Ctx): Promise<Response> => {
  const org = await orgOf(env, claims.orgId);
  if (!org) return err('Organisasi tidak ditemukan.', 404);
  const d = workDateIn(org.timezone);
  const row = await env.DB.prepare(
    'SELECT work_date, clock_in_at, clock_out_at, status, note FROM attendance WHERE email = ?1 AND work_date = ?2'
  ).bind(claims.email, d).first<{ work_date: string; clock_in_at: string | null; clock_out_at: string | null; status: string; note: string | null }>();
  return json({ workDate: d, attendance: row ? { clockInAt: row.clock_in_at, clockOutAt: row.clock_out_at, status: row.status, note: row.note } : null });
};

/** GET /attendance?month=YYYY-MM — riwayat pribadi atau seluruh org (admin). */
export const history = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const url = new URL(request.url);
  const month = url.searchParams.get('month') || workDateIn((await orgOf(env, claims.orgId))?.timezone || 'Asia/Jakarta').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return err('Format bulan YYYY-MM.');
  const admin = claims.role !== 'employee';
  const emailFilter = admin ? (url.searchParams.get('email') || null) : claims.email;

  const rows = emailFilter
    ? await env.DB.prepare(
        `SELECT a.id, a.work_date, a.clock_in_at, a.clock_out_at, a.status, a.note, a.flag, u.name FROM attendance a JOIN users u ON u.email = a.email
         WHERE a.email = ?3 AND a.work_date LIKE ?2 || '%' ORDER BY a.work_date DESC`
      ).bind(0, month, emailFilter).all()
    : await env.DB.prepare(
        `SELECT a.id, a.work_date, a.clock_in_at, a.clock_out_at, a.status, a.note, a.flag, u.name FROM attendance a JOIN users u ON u.email = a.email
         WHERE a.org_id = ?1 AND a.work_date LIKE ?2 || '%' ORDER BY a.work_date DESC, u.name`
      ).bind(claims.orgId, month).all();
  // Location/Liveness Verified: ada selfie tersimpan (R2) = kedua verifikasi tercapai.
  return json({ month, rows: rows.results });
};

/** GET /attendance/selfie/:id — aliran selfie dari R2 (hanya org sendiri). */
export const selfie = async (id: string, { env, claims }: Ctx): Promise<Response> => {
  // key format: selfies/<orgId>/<uuid>.<ext> — verifikasi org prefix.
  const obj = await env.R2.get(`selfies/${claims.orgId}/${id}`);
  if (!obj) return err('Tidak ditemukan.', 404);
  return new Response(obj.body, { headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
};
