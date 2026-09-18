// ─────────────────────────────────────────────────────────────
// Presensia — Otorisasi berlapis (RBAC + delegasi wewenang).
//
// Role:
//   owner/admin  → seluruh org
//   manager      → HANYA diri + bawahan langsung (users.reports_to)
//   employee     → diri sendiri
// Delegasi: tabel delegations — manager yang cuti/dinas menyerahkan
// hak approve ke rekan selama rentang tanggal (cek otomatis).
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';
import { json, err, uuid, nowISO } from './http';
import type { SessionClaims } from './sessions';

export const isAdminish = (claims: SessionClaims): boolean =>
  claims.role === 'owner' || claims.role === 'admin';

/** Daftar email yang berada dalam scope otorisasi claims (untuk query IN). */
export const scopeEmails = async (env: Env, claims: SessionClaims): Promise<string[] | null> => {
  if (isAdminish(claims)) return null; // null = tanpa filter (seluruh org)
  if (claims.role === 'manager') {
    const rows = await env.DB.prepare(
      'SELECT email FROM users WHERE org_id = ?1 AND (reports_to = ?2 OR email = ?3)'
    ).bind(claims.orgId, claims.email, claims.email).all<{ email: string }>();
    return rows.results.map((r) => r.email);
  }
  return [claims.email];
};

/** Boleh claims melihat/meninjau milik targetEmail? (termasuk delegasi aktif). */
export const canAccessEmployee = async (env: Env, claims: SessionClaims, targetEmail: string): Promise<boolean> => {
  if (isAdminish(claims)) return true;
  if (claims.email === targetEmail) return true;
  if (claims.role === 'manager') {
    const direct = await env.DB.prepare(
      'SELECT email FROM users WHERE email = ?1 AND org_id = ?2 AND reports_to = ?3'
    ).bind(targetEmail, claims.orgId, claims.email).first();
    if (direct) return true;
  }
  // Delegasi aktif: penerima delegasi mewarisi wewenang from_email.
  const from = await env.DB.prepare(
    'SELECT from_email FROM delegations WHERE org_id = ?1 AND to_email = ?2 AND date_from <= date(\'now\') AND date_to >= date(\'now\')'
  ).bind(claims.orgId, claims.email).all<{ from_email: string }>();
  for (const d of from.results) {
    if (d.from_email === targetEmail) return true; // delegasi langsung
    const subordinate = await env.DB.prepare(
      'SELECT email FROM users WHERE email = ?1 AND org_id = ?2 AND reports_to = ?3'
    ).bind(targetEmail, claims.orgId, d.from_email).first();
    if (subordinate) return true; // bawahan dari pendelegasi
  }
  return false;
};

/** Kelola delegasi (owner/admin/manager membuat untuk dirinya). */
export const createDelegation = async (
  request: Request, env: Env, claims: SessionClaims,
): Promise<Response> => {
  const body = await request.json().catch(() => null) as {
    toEmail?: string; dateFrom?: string; dateTo?: string; reason?: string;
  } | null;
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!body?.toEmail || !body.dateFrom || !body.dateTo || !dateRe.test(body.dateFrom) || !dateRe.test(body.dateTo) || body.dateTo < body.dateFrom) {
    return err('Data delegasi tidak valid.');
  }
  const target = await env.DB.prepare('SELECT role FROM users WHERE email = ?1 AND org_id = ?2')
    .bind(body.toEmail, claims.orgId).first<{ role: string }>();
  if (!target) return err('Penerima delegasi tidak ditemukan.', 404);
  if (target.role === 'employee') return err('Delegasi hanya ke manager/admin.', 400);
  if (body.toEmail === claims.email) return err('Tidak bisa mendelegasikan ke diri sendiri.');

  const id = uuid();
  await env.DB.prepare(
    'INSERT INTO delegations (id, org_id, from_email, to_email, date_from, date_to, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
  ).bind(id, claims.orgId, claims.email, body.toEmail, body.dateFrom, body.dateTo,
    body.reason?.slice(0, 200) ?? null, nowISO()).run();
  return json({ delegation: { id, toEmail: body.toEmail, dateFrom: body.dateFrom, dateTo: body.dateTo } }, 201);
};

/** GET /delegations — daftar delegasi yang relevan (dibuat / diterima). */
export const listDelegations = async (env: Env, claims: SessionClaims): Promise<Response> => {
  const rows = isAdminish(claims)
    ? await env.DB.prepare(
        'SELECT * FROM delegations WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 100'
      ).bind(claims.orgId).all<Record<string, unknown>>()
    : await env.DB.prepare(
        `SELECT * FROM delegations WHERE org_id = ?1 AND (from_email = ?2 OR to_email = ?2) ORDER BY created_at DESC LIMIT 100`
      ).bind(claims.orgId, claims.email).all<Record<string, unknown>>();
  return json({ delegations: rows.results.map((r) => ({
    id: r.id, fromEmail: r.from_email, toEmail: r.to_email,
    dateFrom: r.date_from, dateTo: r.date_to, reason: r.reason, createdAt: r.created_at,
  })) });
};
