// ─────────────────────────────────────────────────────────────
// Presensia — autentikasi: daftar org baru, login, profil, logout.
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err, nowISO, corsHeaders } from '../http';
import { hashPassword, verifyPassword } from '../passwords';
import { issueSession, sessionCookie, clearSessionCookie } from '../sessions';
import { rateLimit, clientIp } from '../ratelimit';
import { audit } from '../audit';

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';

/** POST /register — daftar org baru + owner. Trial 14 hari otomatis. */
export const handleRegister = async (request: Request, env: Env): Promise<Response> => {
  if (!(await rateLimit(env, `reg:${clientIp(request)}`, 5))) {
    return err('Terlalu banyak percobaan — coba lagi beberapa menit lagi.', 429);
  }
  const body = await request.json().catch(() => null) as {
    orgName?: string; name?: string; email?: string; password?: string;
  } | null;
  const orgName = body?.orgName?.trim() || '';
  const name = body?.name?.trim() || '';
  const email = body?.email?.trim().toLowerCase() || '';
  const password = body?.password || '';
  if (!orgName || !name || !email || !email.includes('@')) return err('Data tidak lengkap.');
  const pwErr = (() => {
    if (password.length < 8) return 'Kata sandi minimal 8 karakter';
    if (password.length > 128) return 'Kata sandi maksimal 128 karakter';
    return null;
  })();
  if (pwErr) return err(pwErr);

  const exists = await env.DB.prepare('SELECT email FROM users WHERE email = ?1').bind(email).first();
  if (exists) return err('Email sudah terdaftar.', 409);

  const orgId = crypto.randomUUID();
  let slug = slugify(orgName);
  const slugTaken = await env.DB.prepare('SELECT id FROM orgs WHERE slug = ?1').bind(slug).first();
  if (slugTaken) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;

  const trialEnd = new Date(Date.now() + 14 * 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO orgs (id, name, slug, plan, plan_expires_at, created_at) VALUES (?1, ?2, ?3, ?, ?4, ?5)')
      .bind(orgId, orgName, slug, 'trial', trialEnd, nowISO()),
    env.DB.prepare('INSERT INTO users (email, org_id, name, role, password_hash, created_at) VALUES (?1, ?2, ?3, ?, ?4, ?5)')
      .bind(email, orgId, name, 'owner', await hashPassword(password), nowISO()),
  ]);

  const token = await issueSession(env, { email, orgId, role: 'owner' });
  await audit(env, email, 'register', `org=${orgName}`);
  return json({ org: { id: orgId, name: orgName, slug, plan: 'trial', planExpiresAt: trialEnd }, email, name, role: 'owner' }, 201, {
    'Set-Cookie': sessionCookie(token),
  });
};

/** POST /login */
export const handleLogin = async (request: Request, env: Env): Promise<Response> => {
  if (!(await rateLimit(env, `login:${clientIp(request)}`, 10))) {
    return err('Terlalu banyak percobaan login — coba lagi nanti.', 429);
  }
  const body = await request.json().catch(() => null) as { email?: string; password?: string } | null;
  const email = body?.email?.trim().toLowerCase() || '';
  const password = body?.password || '';
  if (!email || !password) return err('Email dan kata sandi wajib diisi.');

  const user = await env.DB.prepare(
    'SELECT u.email, u.org_id, u.name, u.role, u.password_hash, o.plan, o.plan_expires_at, o.name AS org_name, o.slug FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.email = ?1'
  ).bind(email).first<{
    email: string; org_id: string; name: string; role: string; password_hash: string;
    plan: string; plan_expires_at: string | null; org_name: string; slug: string;
  }>();
  // Hash dummy untuk kesetaraan waktu (anti user-enumeration).
  const hash = user?.password_hash || 'pbkdf2$300000$AAAA$AAAA';
  const ok = await verifyPassword(password, hash);
  if (!user || !ok) return err('Email atau kata sandi salah.', 401);

  const token = await issueSession(env, { email: user.email, orgId: user.org_id, role: user.role });
  await audit(env, email, 'login', '', clientIp(request));
  return json({
    email: user.email, name: user.name, role: user.role,
    org: { id: user.org_id, name: user.org_name, slug: user.slug, plan: user.plan, planExpiresAt: user.plan_expires_at },
  }, 200, { 'Set-Cookie': sessionCookie(token) });
};

/** GET /me — profil sesi aktif. */
export const handleMe = async (env: Env, claims: { email: string; orgId: string; role: string }): Promise<Response> => {
  const user = await env.DB.prepare(
    'SELECT u.email, u.name, u.role, u.phone, u.avatar_path, o.name AS org_name, o.plan, o.plan_expires_at FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.email = ?1'
  ).bind(claims.email).first<{
    email: string; name: string; role: string; phone: string | null; avatar_path: string | null;
    org_name: string; plan: string; plan_expires_at: string | null;
  }>();
  if (!user) return err('Sesi tidak valid.', 401);
  return json({
    email: user.email, name: user.name, role: user.role, phone: user.phone,
    avatarUrl: user.avatar_path ? `/me/avatar` : null,
    org: { name: user.org_name, plan: user.plan, planExpiresAt: user.plan_expires_at },
  });
};

/** POST /logout */
export const handleLogout = (): Response => json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });

/** Preflight OPTIONS global. */
export const preflight = (): Response => new Response(null, { status: 204, headers: corsHeaders });
