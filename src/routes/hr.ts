// ─────────────────────────────────────────────────────────────
// Presensia — HR: hari libur, saldo cuti, lembur,
// dan koreksi absensi self-service (alur ABS-05).
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err, nowISO, uuid } from '../http';
import { audit } from '../audit';
import { canAccessEmployee, isAdminish } from '../authz';
import type { SessionClaims } from '../sessions';

interface Ctx { env: Env; claims: SessionClaims }

const requireAdmin = (claims: SessionClaims): Response | null =>
  claims.role === 'employee' ? err('Hanya admin/owner.', 403) : null;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ── Hari libur nasional / cuti bersama per org ───────────── */

/** GET /holidays?year=YYYY — daftar libur org. */
export const listHolidays = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const year = new URL(request.url).searchParams.get('year') || String(new Date().getFullYear());
  if (!/^\d{4}$/.test(year)) return err('Format tahun YYYY.');
  const rows = await env.DB.prepare(
    'SELECT date, name FROM holidays WHERE org_id = ?1 AND date LIKE ?2 || "%" ORDER BY date'
  ).bind(claims.orgId, year).all<{ date: string; name: string }>();
  return json({ holidays: rows.results });
};

/** PUT /holidays — { date, name } upsert; { date, remove: true } hapus. */
export const upsertHoliday = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const body = await request.json().catch(() => null) as
    { date?: string; name?: string; remove?: boolean } | null;
  if (!body?.date || !DATE_RE.test(body.date)) return err('Tanggal wajib format YYYY-MM-DD.');
  if (body.remove) {
    await env.DB.prepare('DELETE FROM holidays WHERE org_id = ?1 AND date = ?2')
      .bind(claims.orgId, body.date).run();
    await audit(env, claims.email, 'delete-holiday', body.date);
    return json({ ok: true });
  }
  const name = body.name?.trim();
  if (!name) return err('Nama hari libur wajib diisi.');
  await env.DB.prepare(
    `INSERT INTO holidays (org_id, date, name) VALUES (?1, ?2, ?3)
     ON CONFLICT(org_id, date) DO UPDATE SET name = excluded.name`
  ).bind(claims.orgId, body.date, name.slice(0, 60)).run();
  await audit(env, claims.email, 'upsert-holiday', `${body.date} ${name.slice(0, 40)}`);
  return json({ ok: true });
};

/** ── Saldo cuti (CUT-01) ───────────────────────────────────── */
// Kuota bawaan 12 hari kerja/tahun (UU 13/2003), dapat di-override per org
// via app_config `leave_quota:<orgId>`. Terpakai = hari approved tahun ini.

const defaultQuota = async (env: Env, orgId: string): Promise<number> => {
  const row = await env.DB.prepare(
    "SELECT value FROM app_config WHERE key = ?1"
  ).bind(`leave_quota:${orgId}`).first<{ value: string }>();
  const n = row?.value ? Number(row.value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 12;
};

export const leaveQuota = defaultQuota;

/** GET /leaves/balance — saldo cuti (self atau seluruh org utk admin). */
export const leaveBalances = async ({ env, claims }: Ctx): Promise<Response> => {
  const year = String(new Date().getFullYear());
  const quota = await defaultQuota(env, claims.orgId);
  const rows = isAdminish(claims)
    ? await env.DB.prepare(
        `SELECT u.email, u.name, COALESCE(SUM(
           CASE WHEN l.status = 'approved' AND l.type = 'leave'
                AND l.date_from LIKE ?2 || '%' THEN
             (julianday(l.date_to) - julianday(l.date_from)) + 1 ELSE 0 END), 0) AS used
         FROM users u LEFT JOIN leave_requests l ON l.email = u.email
         WHERE u.org_id = ?1 GROUP BY u.email ORDER BY u.name`
      ).bind(claims.orgId, year).all<{ email: string; name: string; used: number }>()
    : await env.DB.prepare(
        `SELECT u.email, u.name, COALESCE(SUM(
           CASE WHEN l.status = 'approved' AND l.type = 'leave'
                AND l.date_from LIKE ?2 || '%' THEN
             (julianday(l.date_to) - julianday(l.date_from)) + 1 ELSE 0 END), 0) AS used
         FROM users u LEFT JOIN leave_requests l ON l.email = u.email
         WHERE u.email = ?3 GROUP BY u.email`
      ).bind(claims.orgId, year, claims.email).all<{ email: string; name: string; used: number }>();
  return json({
    year: Number(year), quota,
    balances: rows.results.map((r) => ({
      email: r.email, name: r.name, quota, used: Math.round(r.used), remaining: Math.max(0, quota - Math.round(r.used)),
    })),
  });
};

/** ── Lembur (SHF-03/04) ────────────────────────────────────── */

/** GET /overtime — pengajuan lembur (admin: org; lainnya: miliknya). */
export const listOvertime = async ({ env, claims }: Ctx): Promise<Response> => {
  const rows = isAdminish(claims)
    ? await env.DB.prepare(
        `SELECT o.*, u.name FROM overtime_requests o JOIN users u ON u.email = o.email
         WHERE o.org_id = ?1 ORDER BY o.created_at DESC LIMIT 200`
      ).bind(claims.orgId).all<Record<string, unknown>>()
    : await env.DB.prepare(
        `SELECT o.*, u.name FROM overtime_requests o JOIN users u ON u.email = o.email
         WHERE o.email = ?1 ORDER BY o.created_at DESC LIMIT 100`
      ).bind(claims.email).all<Record<string, unknown>>();
  return json({ overtime: rows.results.map((r) => ({
    id: r.id, email: r.email, name: r.name, workDate: r.work_date, minutes: r.minutes,
    reason: r.reason, status: r.status, reviewedBy: r.reviewed_by, createdAt: r.created_at,
  })) });
};

/** POST /overtime — { workDate, minutes, reason }. */
export const requestOvertime = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const body = await request.json().catch(() => null) as
    { workDate?: string; minutes?: number; reason?: string } | null;
  if (!body?.workDate || !DATE_RE.test(body.workDate)) return err('Tanggal lembur wajib format YYYY-MM-DD.');
  const minutes = Math.round(body.minutes ?? 0);
  if (!Number.isFinite(minutes) || minutes < 30 || minutes > 480) return err('Durasi lembur 30–480 menit.');
  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO overtime_requests (id, org_id, email, work_date, minutes, reason, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  ).bind(id, claims.orgId, claims.email, body.workDate, minutes, body.reason?.slice(0, 300) ?? null, nowISO()).run();
  await audit(env, claims.email, 'request-overtime', `${body.workDate} ${minutes}m`);
  return json({ ok: true, id }, 201);
};

/** POST /overtime/:id/review — { approve } (manager bawahan / admin). */
export const reviewOvertime = async (request: Request, id: string, { env, claims }: Ctx): Promise<Response> => {
  const body = await request.json().catch(() => null) as { approve?: boolean } | null;
  if (typeof body?.approve !== 'boolean') return err('Keputusan approve wajib boolean.');
  const row = await env.DB.prepare('SELECT * FROM overtime_requests WHERE id = ?1 AND org_id = ?2')
    .bind(id, claims.orgId).first<{ email: string; status: string }>();
  if (!row) return err('Pengajuan lembur tidak ditemukan.', 404);
  if (row.status !== 'pending') return err('Pengajuan sudah ditinjau.', 409);
  if (!isAdminish(claims)) {
    if (claims.role !== 'manager') return err('Hanya manager/admin.', 403);
    if (!(await canAccessEmployee(env, claims, row.email))) return err('Bukan bawahan Anda.', 403);
  }
  const status = body.approve ? 'approved' : 'rejected';
  await env.DB.prepare('UPDATE overtime_requests SET status = ?1, reviewed_by = ?2, reviewed_at = ?3 WHERE id = ?4')
    .bind(status, claims.email, nowISO(), id).run();
  await audit(env, claims.email, body.approve ? 'approve-overtime' : 'reject-overtime', id);
  return json({ ok: true, status });
};

/** ── Koreksi absensi self-service (ABS-05) ─────────────────── */

/** GET /attendance-requests — pengajuan koreksi (admin: org). */
export const listAttendanceRequests = async ({ env, claims }: Ctx): Promise<Response> => {
  const rows = isAdminish(claims)
    ? await env.DB.prepare(
        `SELECT r.*, u.name FROM attendance_requests r JOIN users u ON u.email = r.email
         WHERE r.org_id = ?1 ORDER BY r.created_at DESC LIMIT 200`
      ).bind(claims.orgId).all<Record<string, unknown>>()
    : await env.DB.prepare(
        `SELECT r.*, u.name FROM attendance_requests r JOIN users u ON u.email = r.email
         WHERE r.email = ?1 ORDER BY r.created_at DESC LIMIT 100`
      ).bind(claims.email).all<Record<string, unknown>>();
  return json({ requests: rows.results.map((r) => ({
    id: r.id, email: r.email, name: r.name, workDate: r.work_date,
    clockInAt: r.clock_in_at, clockOutAt: r.clock_out_at, reason: r.reason,
    status: r.status, reviewedBy: r.reviewed_by, reviewNote: r.review_note, createdAt: r.created_at,
  })) });
};

/** POST /attendance-requests — { workDate, clockInAt?, clockOutAt?, reason }. */
export const requestCorrection = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const body = await request.json().catch(() => null) as {
    workDate?: string; clockInAt?: string; clockOutAt?: string; reason?: string;
  } | null;
  if (!body?.workDate || !DATE_RE.test(body.workDate)) return err('Tanggal wajib format YYYY-MM-DD.');
  const reason = body.reason?.trim();
  if (!reason || reason.length < 4) return err('Alasan koreksi wajib (min 4 karakter).');
  if (!body.clockInAt && !body.clockOutAt) return err('Isi minimal salah satu jam masuk/keluar.');
  const timeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  if (body.clockInAt && !timeRe.test(body.clockInAt)) return err('Format clockInAt ISO tidak valid.');
  if (body.clockOutAt && !timeRe.test(body.clockOutAt)) return err('Format clockOutAt ISO tidak valid.');
  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO attendance_requests (id, org_id, email, work_date, clock_in_at, clock_out_at, reason, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(id, claims.orgId, claims.email, body.workDate,
    body.clockInAt ?? null, body.clockOutAt ?? null, reason.slice(0, 300), nowISO()).run();
  await audit(env, claims.email, 'request-correction', `${body.workDate}`);
  return json({ ok: true, id }, 201);
};

/** POST /attendance-requests/:id/review — approve → terapkan ke attendance
 *  (append-only correction audit), tolak → simpan alasan reviewer. */
export const reviewCorrection = async (request: Request, id: string, { env, claims }: Ctx): Promise<Response> => {
  const body = await request.json().catch(() => null) as { approve?: boolean; note?: string } | null;
  if (typeof body?.approve !== 'boolean') return err('Keputusan approve wajib boolean.');
  const row = await env.DB.prepare('SELECT * FROM attendance_requests WHERE id = ?1 AND org_id = ?2')
    .bind(id, claims.orgId).first<{
      email: string; work_date: string; clock_in_at: string | null; clock_out_at: string | null; status: string;
    }>();
  if (!row) return err('Pengajuan tidak ditemukan.', 404);
  if (row.status !== 'pending') return err('Pengajuan sudah ditinjau.', 409);
  if (!isAdminish(claims)) {
    if (claims.role !== 'manager') return err('Hanya manager/admin.', 403);
    if (!(await canAccessEmployee(env, claims, row.email))) return err('Bukan bawahan Anda.', 403);
  }

  if (!body.approve) {
    await env.DB.prepare(
      "UPDATE attendance_requests SET status = 'rejected', reviewed_by = ?1, reviewed_at = ?2, review_note = ?3 WHERE id = ?4"
    ).bind(claims.email, nowISO(), body.note?.slice(0, 200) ?? null, id).run();
    await audit(env, claims.email, 'reject-correction', id);
    return json({ ok: true, status: 'rejected' });
  }

  // Terapkan ke baris attendance (buat bila belum ada — mis. lupa absen).
  const existing = await env.DB.prepare(
    'SELECT id FROM attendance WHERE email = ?1 AND work_date = ?2'
  ).bind(row.email, row.work_date).first<{ id: string }>();
  if (existing) {
    const sets: string[] = [];
    const vals: (string | null)[] = [];
    if (row.clock_in_at) { sets.push('clock_in_at = ?'); vals.push(row.clock_in_at); }
    if (row.clock_out_at) { sets.push('clock_out_at = ?'); vals.push(row.clock_out_at); }
    if (sets.length) {
      vals.push(existing.id);
      await env.DB.prepare(`UPDATE attendance SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
      for (const [field, value] of [
        ...(row.clock_in_at ? [['clock_in_at', row.clock_in_at] as const] : []),
        ...(row.clock_out_at ? [['clock_out_at', row.clock_out_at] as const] : []),
      ]) {
        await env.DB.prepare(
          'INSERT INTO attendance_corrections (attendance_id, actor, field, old_value, new_value, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
        ).bind(existing.id, claims.email, field, null, value, `koreksi disetujui: ${row.work_date}`).run();
      }
    }
  } else {
    const attId = uuid();
    await env.DB.prepare(
      `INSERT INTO attendance (id, org_id, email, work_date, clock_in_at, clock_out_at, status, note, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'present', ?7, ?8)`
    ).bind(attId, claims.orgId, row.email, row.work_date, row.clock_in_at, row.clock_out_at,
      'dibuat dari koreksi disetujui', nowISO()).run();
  }
  await env.DB.prepare(
    "UPDATE attendance_requests SET status = 'approved', reviewed_by = ?1, reviewed_at = ?2, review_note = ?3 WHERE id = ?4"
  ).bind(claims.email, nowISO(), body.note?.slice(0, 200) ?? null, id).run();
  await audit(env, claims.email, 'approve-correction', `${row.email} ${row.work_date}`);
  return json({ ok: true, status: 'approved' });
};
