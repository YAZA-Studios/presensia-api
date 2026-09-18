// ─────────────────────────────────────────────────────────────
// Hadirku — manajemen karyawan & pengajuan izin/cuti.
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err, nowISO, uuid } from '../http';
import { hashPassword } from '../passwords';
import { audit } from '../audit';
import type { SessionClaims } from '../sessions';

interface Ctx { env: Env; claims: SessionClaims }

const requireAdmin = (claims: SessionClaims): Response | null =>
  claims.role === 'employee' ? err('Hanya admin/owner.', 403) : null;

/** GET /employees — daftar karyawan org. */
export const list = async ({ env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const rows = await env.DB.prepare(
    `SELECT u.email, u.name, u.role, u.phone, u.created_at,
       (SELECT COUNT(*) FROM attendance a WHERE a.email = u.email AND a.status IN ('present','late')) AS total_hadir
     FROM users u WHERE u.org_id = ?1 ORDER BY u.created_at`
  ).bind(claims.orgId).all<{ email: string; name: string; role: string; phone: string | null; created_at: string; total_hadir: number }>();
  return json({ employees: rows.results.map((r) => ({ email: r.email, name: r.name, role: r.role, phone: r.phone, createdAt: r.created_at, totalHadir: r.total_hadir })) });
};

/** POST /employees — tambah karyawan (admin isi sandi awal). */
export const create = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const body = await request.json().catch(() => null) as {
    email?: string; name?: string; phone?: string; password?: string; role?: 'admin' | 'employee';
  } | null;
  const email = body?.email?.trim().toLowerCase() || '';
  if (!email || !email.includes('@') || !body?.name) return err('Nama & email wajib diisi.');
  if (!body.password || body.password.length < 8) return err('Kata sandi awal minimal 8 karakter.');
  const exists = await env.DB.prepare('SELECT email FROM users WHERE email = ?1').bind(email).first();
  if (exists) return err('Email sudah terdaftar.', 409);

  await env.DB.prepare(
    'INSERT INTO users (email, org_id, name, role, password_hash, phone, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  ).bind(email, claims.orgId, body.name.slice(0, 80), body.role === 'admin' ? 'admin' : 'employee',
    await hashPassword(body.password), body.phone?.slice(0, 24) ?? null, nowISO()).run();
  await audit(env, claims.email, 'create-employee', email);
  return json({ employee: { email, name: body.name, role: body.role === 'admin' ? 'admin' : 'employee' } }, 201);
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
    'INSERT INTO leave_requests (id, org_id, email, type, date_from, date_to, reason, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?, ?8)'
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

/** POST /leaves/:id/review — setujui/tolak (admin). Disetujui → attendance
 *  hari tsb otomatis berstatus leave/sick (anti "absent"). */
export const reviewLeave = async (request: Request, id: string, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const body = await request.json().catch(() => null) as { approve?: boolean } | null;
  if (typeof body?.approve !== 'boolean') return err('Keputusan approve wajib boolean.');

  const leave = await env.DB.prepare('SELECT * FROM leave_requests WHERE id = ?1 AND org_id = ?2')
    .bind(id, claims.orgId).first<{ email: string; type: string; date_from: string; date_to: string; status: string }>();
  if (!leave) return err('Pengajuan tidak ditemukan.', 404);
  if (leave.status !== 'pending') return err('Pengajuan sudah ditinjau.', 409);

  await env.DB.prepare('UPDATE leave_requests SET status = ?1, reviewed_by = ?2, reviewed_at = ?3 WHERE id = ?4')
    .bind(body.approve ? 'approved' : 'rejected', claims.email, nowISO(), id).run();

  if (body.approve) {
    // Tandai attendance leave/sick untuk rentang tanggal (idempoten: hanya isi bila belum ada baris).
    const status = leave.type === 'sick' ? 'sick' : 'leave';
    const start = new Date(leave.date_from + 'T00:00:00Z').getTime();
    const end = new Date(leave.date_to + 'T00:00:00Z').getTime();
    for (let t = start; t <= end; t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      await env.DB.prepare(
        `INSERT INTO attendance (id, org_id, email, work_date, status, note, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'izin disetujui', ?6)
         ON CONFLICT(email, work_date) DO NOTHING`
      ).bind(uuid(), claims.orgId, leave.email, d, status, nowISO()).run();
    }
  }
  await audit(env, claims.email, body.approve ? 'approve-leave' : 'reject-leave', `${leave.email} ${id}`);
  return json({ ok: true, status: body.approve ? 'approved' : 'rejected' });
};
