// ─────────────────────────────────────────────────────────────
// Presensia — manajemen karyawan & pengajuan izin/cuti.
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err, nowISO, uuid } from '../http';
import { hashPassword } from '../passwords';
import { audit } from '../audit';
import { getPolicy } from '../policies';
import { canAccessEmployee, isAdminish } from '../authz';
import type { SessionClaims } from '../sessions';

interface Ctx { env: Env; claims: SessionClaims }

const requireAdmin = (claims: SessionClaims): Response | null =>
  claims.role === 'employee' ? err('Hanya admin/owner.', 403) : null;

/** GET /employees — daftar karyawan SESUAI SCOPE RBAC:
 *  owner/admin = seluruh org, manager = bawahan langsung + diri. */
export const list = async ({ env, claims }: Ctx): Promise<Response> => {
  const base = `SELECT u.email, u.name, u.role, u.phone, u.created_at, u.reports_to,
       (SELECT COUNT(*) FROM attendance a WHERE a.email = u.email AND a.status IN ('present','late')) AS total_hadir
     FROM users u WHERE u.org_id = ?1`;
  const rows = isAdminish(claims)
    ? await env.DB.prepare(`${base} ORDER BY u.created_at`).bind(claims.orgId)
        .all<{ email: string; name: string; role: string; phone: string | null; created_at: string; reports_to: string | null; total_hadir: number }>()
    : claims.role === 'manager'
      ? await env.DB.prepare(`${base} AND (u.reports_to = ?2 OR u.email = ?2) ORDER BY u.created_at`).bind(claims.orgId, claims.email)
          .all<{ email: string; name: string; role: string; phone: string | null; created_at: string; reports_to: string | null; total_hadir: number }>()
      : await env.DB.prepare(`${base} AND u.email = ?2 ORDER BY u.created_at`).bind(claims.orgId, claims.email)
          .all<{ email: string; name: string; role: string; phone: string | null; created_at: string; reports_to: string | null; total_hadir: number }>();
  // Catatan: cabang admin hanya memakai ?1 (tanpa ?2) — sah di SQLite;
  // ?2 eksis hanya di cabang manager/employee.
  return json({ employees: rows.results.map((r) => ({ email: r.email, name: r.name, role: r.role, phone: r.phone, createdAt: r.created_at, reportsTo: r.reports_to, totalHadir: r.total_hadir })) });
};

/** POST /employees — tambah karyawan (admin isi sandi awal). */
export const create = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const body = await request.json().catch(() => null) as {
    email?: string; name?: string; phone?: string; password?: string; role?: 'admin' | 'manager' | 'employee'; reportsTo?: string;
  } | null;
  const email = body?.email?.trim().toLowerCase() || '';
  if (!email || !email.includes('@') || !body?.name) return err('Nama & email wajib diisi.');
  if (!body.password || body.password.length < 8) return err('Kata sandi awal minimal 8 karakter.');
  const exists = await env.DB.prepare('SELECT email FROM users WHERE email = ?1').bind(email).first();
  if (exists) return err('Email sudah terdaftar.', 409);

  const role = ['admin', 'manager', 'employee'].includes(body.role || '') ? body.role! : 'employee';
  const reportsTo = role === 'employee' || role === 'manager'
    ? (body.reportsTo?.trim().toLowerCase() || null)
    : null;
  if (reportsTo) {
    const sup = await env.DB.prepare('SELECT email FROM users WHERE email = ?1 AND org_id = ?2')
      .bind(reportsTo, claims.orgId).first();
    if (!sup) return err('Atasan langsung tidak ditemukan di org ini.', 400);
  }
  await env.DB.prepare(
    'INSERT INTO users (email, org_id, name, role, password_hash, phone, reports_to, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
  ).bind(email, claims.orgId, body.name.slice(0, 80), role,
    await hashPassword(body.password), body.phone?.slice(0, 24) ?? null, reportsTo, nowISO()).run();
  await audit(env, claims.email, 'create-employee', email);
  return json({ employee: { email, name: body.name, role } }, 201);
};

/** POST /employees/shift — assign shift ke karyawan (berlaku hari ini).
 *  Body: { email, shiftId }. Owner/admin saja. */
export const assignShift = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const body = await request.json().catch(() => null) as { email?: string; shiftId?: string } | null;
  const email = body?.email?.trim().toLowerCase() || '';
  if (!email || !body?.shiftId) return err('Email & shiftId wajib diisi.');
  const user = await env.DB.prepare('SELECT email FROM users WHERE email = ?1 AND org_id = ?2')
    .bind(email, claims.orgId).first();
  if (!user) return err('Karyawan tidak ditemukan.', 404);
  const shift = await env.DB.prepare('SELECT id FROM shifts WHERE id = ?1 AND org_id = ?2')
    .bind(body.shiftId, claims.orgId).first();
  if (!shift) return err('Shift tidak ditemukan.', 404);
  // Upsert penugasan efektif hari ini (PK: email + effective_from).
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(
    `INSERT INTO employee_shifts (email, shift_id, effective_from) VALUES (?1, ?2, ?3)
     ON CONFLICT(email, effective_from) DO UPDATE SET shift_id = ?2`
  ).bind(email, body.shiftId, today).run();
  await audit(env, claims.email, 'assign-shift', `${email} → ${body.shiftId}`);
  return json({ ok: true }, 201);
};

/** DELETE /employees/:email — hapus karyawan (bukan owner). */
export const remove = async (emailRaw: string, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const email = decodeURIComponent(emailRaw).toLowerCase();
  const target = await env.DB.prepare('SELECT role FROM users WHERE email = ?1 AND org_id = ?2').bind(email, claims.orgId).first<{ role: string }>();
  if (!target) return err('Karyawan tidak ditemukan.', 404);
  if (target.role === 'owner') return err('Owner tidak bisa dihapus.', 403);
  await env.DB.prepare('DELETE FROM users WHERE email = ?1 AND org_id = ?2').bind(email, claims.orgId).run();
  await audit(env, claims.email, 'delete-employee', email);
  return json({ ok: true });
};

/** ── Izin / cuti / sakit ──────────────────────────────────── */

/** POST /leaves — karyawan ajukan. */
export const requestLeave = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const body = await request.json().catch(() => null) as {
    type?: 'leave' | 'sick' | 'remote'; dateFrom?: string; dateTo?: string; reason?: string;
  } | null;
  const type = body?.type;
  if (type !== 'leave' && type !== 'sick' && type !== 'remote') return err('Jenis pengajuan tidak valid.');
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!body?.dateFrom || !body.dateTo || !dateRe.test(body.dateFrom) || !dateRe.test(body.dateTo) || body.dateTo < body.dateFrom) {
    return err('Rentang tanggal tidak valid.');
  }
  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO leave_requests (id, org_id, email, type, date_from, date_to, reason, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
  ).bind(id, claims.orgId, claims.email, type, body.dateFrom, body.dateTo, body.reason?.slice(0, 300) ?? null, 'pending', nowISO()).run();
  await audit(env, claims.email, 'request-leave', `${type} ${body.dateFrom}..${body.dateTo}`);
  return json({ leave: { id, type, dateFrom: body.dateFrom, dateTo: body.dateTo, status: 'pending' } }, 201);
};

/** GET /leaves — daftar pengajuan (admin: semua; karyawan: miliknya). */
export const listLeaves = async ({ env, claims }: Ctx): Promise<Response> => {
  const admin = claims.role !== 'employee';
  const rows = admin
    ? await env.DB.prepare(
        `SELECT l.*, u.name FROM leave_requests l JOIN users u ON u.email = l.email WHERE l.org_id = ?1 ORDER BY l.created_at DESC LIMIT 200`
      ).bind(claims.orgId).all<Record<string, unknown>>()
    : await env.DB.prepare(
        `SELECT l.*, u.name FROM leave_requests l JOIN users u ON u.email = l.email WHERE l.email = ?1 ORDER BY l.created_at DESC LIMIT 100`
      ).bind(claims.email).all<Record<string, unknown>>();
  return json({ leaves: rows.results.map((r) => ({
    id: r.id, email: r.email, name: r.name, type: r.type, dateFrom: r.date_from, dateTo: r.date_to,
    reason: r.reason, status: r.status, reviewedBy: r.reviewed_by, createdAt: r.created_at,
  })) });
};

/** POST /leaves/:id/review — approval BERTINGKAT (multi-tier):
 *  - Manager: bisa approve bawahan langsung (atau via delegasi).
 *  - Cuti > leave.hrApprovalOverDays hari → tier 2 (admin/HR) wajib:
 *    manager setuju → status 'pending_hr' → admin approve final.
 *  Disetujui penuh → attendance otomatis leave/sick (anti "absent"). */
export const reviewLeave = async (request: Request, id: string, { env, claims }: Ctx): Promise<Response> => {
  const body = await request.json().catch(() => null) as { approve?: boolean } | null;
  if (typeof body?.approve !== 'boolean') return err('Keputusan approve wajib boolean.');

  const leave = await env.DB.prepare('SELECT * FROM leave_requests WHERE id = ?1 AND org_id = ?2')
    .bind(id, claims.orgId).first<{ email: string; type: string; date_from: string; date_to: string; status: string }>();
  if (!leave) return err('Pengajuan tidak ditemukan.', 404);
  if (leave.status !== 'pending' && leave.status !== 'pending_hr') return err('Pengajuan sudah selesai ditinjau.', 409);

  // ── Otorisasi tier 1: manager (bawahan/delegasi) atau admin. ──
  if (!isAdminish(claims)) {
    if (claims.role !== 'manager') return err('Hanya manager/admin.', 403);
    const ok = await canAccessEmployee(env, claims, leave.email);
    if (!ok) return err('Bukan bawahan Anda (dan tidak ada delegasi).', 403);
  }

  // Hitung durasi hari pengajuan.
  const days = Math.max(1, Math.round((new Date(leave.date_to + 'T00:00:00Z').getTime() - new Date(leave.date_from + 'T00:00:00Z').getTime()) / 86_400_000) + 1);
  const policy = await getPolicy(env, claims.orgId);
  const needsHr = policy.leave.hrApprovalOverDays > 0 && days > policy.leave.hrApprovalOverDays;

  // Tier 2 (HR/admin) untuk pengajuan panjang.
  if (leave.status === 'pending_hr') {
    if (!isAdminish(claims)) return err('Pengajuan ini menunggu persetujuan HR/admin (tingkat 2).', 403);
    if (!body.approve) {
      await env.DB.prepare("UPDATE leave_requests SET status = 'rejected', reviewed_by_2 = ?1, reviewed_at_2 = ?2 WHERE id = ?3")
        .bind(claims.email, nowISO(), id).run();
      await audit(env, claims.email, 'reject-leave-hr', `${leave.email} ${id}`);
      return json({ ok: true, status: 'rejected' });
    }
    await markLeaveAttendance(env, claims.orgId, leave);
    await env.DB.prepare("UPDATE leave_requests SET status = 'approved', reviewed_by_2 = ?1, reviewed_at_2 = ?2 WHERE id = ?3")
      .bind(claims.email, nowISO(), id).run();
    await audit(env, claims.email, 'approve-leave-hr', `${leave.email} ${id} (${days} hr)`);
    return json({ ok: true, status: 'approved' });
  }

  if (!body.approve) {
    await env.DB.prepare("UPDATE leave_requests SET status = 'rejected', reviewed_by = ?1, reviewed_at = ?2 WHERE id = ?3")
      .bind(claims.email, nowISO(), id).run();
    await audit(env, claims.email, 'reject-leave', `${leave.email} ${id}`);
    return json({ ok: true, status: 'rejected' });
  }

  if (needsHr && !isAdminish(claims)) {
    await env.DB.prepare("UPDATE leave_requests SET status = 'pending_hr', reviewed_by = ?1, reviewed_at = ?2 WHERE id = ?3")
      .bind(claims.email, nowISO(), id).run();
    await audit(env, claims.email, 'approve-leave-tier1', `${leave.email} ${id} → pending HR (${days} hr)`);
    return json({ ok: true, status: 'pending_hr', note: `Cuti ${days} hari butuh persetujuan HR.` });
  }

  await markLeaveAttendance(env, claims.orgId, leave);
  await env.DB.prepare("UPDATE leave_requests SET status = 'approved', reviewed_by = ?1, reviewed_at = ?2 WHERE id = ?3")
    .bind(claims.email, nowISO(), id).run();
  await audit(env, claims.email, 'approve-leave', `${leave.email} ${id} (${days} hr)`);
  return json({ ok: true, status: 'approved' });
};

const markLeaveAttendance = async (env: Env, orgId: string, leave: { email: string; type: string; date_from: string; date_to: string }): Promise<void> => {
  const status = leave.type === 'sick' ? 'sick' : 'leave';
  const start = new Date(leave.date_from + 'T00:00:00Z').getTime();
  const end = new Date(leave.date_to + 'T00:00:00Z').getTime();
  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    await env.DB.prepare(
      `INSERT INTO attendance (id, org_id, email, work_date, status, note, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'izin disetujui', ?6)
       ON CONFLICT(email, work_date) DO NOTHING`
    ).bind(uuid(), orgId, leave.email, d, status, nowISO()).run();
  }
};

/** ── Koreksi manual admin (append-only audit) ──────────────────── */

/** POST /attendance/:id/correct — admin koreksi jam/status. Nilai LAMA &
 *  BARU + alasan WAJIB dicatat ke attendance_corrections (tanpa hapus). */
export const correctAttendance = async (request: Request, attId: string, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const body = await request.json().catch(() => null) as {
    clockInAt?: string; clockOutAt?: string; status?: string; reason?: string;
  } | null;
  if (!body?.reason || body.reason.trim().length < 4) return err('Alasan koreksi wajib (min 4 karakter).');

  const row = await env.DB.prepare(
    'SELECT id, org_id, clock_in_at, clock_out_at, status FROM attendance WHERE id = ?1 AND org_id = ?2'
  ).bind(attId, claims.orgId).first<{ id: string; org_id: string; clock_in_at: string | null; clock_out_at: string | null; status: string }>();
  if (!row) return err('Data absensi tidak ditemukan.', 404);

  const timeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  const changes: [string, string | null, string | null][] = [];
  if (body.clockInAt !== undefined && body.clockInAt !== row.clock_in_at) {
    if (body.clockInAt !== null && !timeRe.test(body.clockInAt)) return err('Format clockInAt ISO tidak valid.');
    changes.push(['clock_in_at', row.clock_in_at, body.clockInAt]);
  }
  if (body.clockOutAt !== undefined && body.clockOutAt !== row.clock_out_at) {
    if (body.clockOutAt !== null && !timeRe.test(body.clockOutAt)) return err('Format clockOutAt ISO tidak valid.');
    changes.push(['clock_out_at', row.clock_out_at, body.clockOutAt]);
  }
  if (body.status !== undefined && body.status !== row.status) {
    if (!['present', 'late', 'absent', 'leave', 'sick', 'holiday'].includes(body.status)) return err('Status tidak dikenal.');
    changes.push(['status', row.status, body.status]);
  }
  if (!changes.length) return err('Tidak ada perubahan nilai.');

  const sets = changes.map(([f], i) => `${f} = ?${i + 1}`).join(', ');
  await env.DB.prepare(`UPDATE attendance SET ${sets} WHERE id = ?${changes.length + 1}`)
    .bind(...changes.map(([, , nv]) => nv), attId).run();
  for (const [field, oldV, newV] of changes) {
    await env.DB.prepare(
      'INSERT INTO attendance_corrections (attendance_id, actor, field, old_value, new_value, reason) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
    ).bind(attId, claims.email, field, oldV, newV, body.reason.slice(0, 300)).run();
  }
  await audit(env, claims.email, 'correct-attendance', `${attId}: ${changes.map(([f]) => f).join(',')} — ${body.reason.slice(0, 80)}`);
  return json({ ok: true, corrected: changes.map(([f]) => f) });
};

/** GET /attendance/:id/corrections — riwayat koreksi (append-only). */
export const listCorrections = async (attId: string, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const rows = await env.DB.prepare(
    'SELECT actor, field, old_value, new_value, reason, created_at FROM attendance_corrections WHERE attendance_id = ?1 ORDER BY created_at DESC'
  ).bind(attId).all<Record<string, unknown>>();
  return json({ corrections: rows.results.map((r) => ({
    actor: r.actor, field: r.field, oldValue: r.old_value, newValue: r.new_value,
    reason: r.reason, at: r.created_at,
  })) });
};
