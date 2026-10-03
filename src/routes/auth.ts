// ─────────────────────────────────────────────────────────────
// Presensia — autentikasi: daftar org baru, login, profil, logout.
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err, nowISO, corsHeaders } from '../http';
import { hashPassword, verifyPassword, PBKDF2_ITERATIONS } from '../passwords';
import { issueSession, sessionCookie, clearSessionCookie, verifySession, revokeRequestSessions } from '../sessions';
import { rateLimit, clientIp } from '../ratelimit';
import { audit } from '../audit';
import { sendEmail } from '../email';
import {
  verifyEmailTemplate, resetPasswordTemplate, passwordChangedTemplate,
  VERIFY_EMAIL_SUBJECT, RESET_PASSWORD_SUBJECT, PASSWORD_CHANGED_SUBJECT,
} from '../emailTemplates';

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';

/** Layanan email Brevo aktif? Tanpa key → verifikasi otomatis lolos
 *  (pendaftaran tetap bisa dipakai sebelum BREVO_API_KEY dipasang). */
export const emailConfigured = (env: Env): boolean => !!env.BREVO_API_KEY && !!env.BREVO_FROM_EMAIL;

/** Token satu-pakai 32 byte hex untuk tautan verifikasi/reset (KV TTL). */
const randomToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

const VERIFY_TTL_SECONDS = 48 * 3600;   // tautan aktivasi: 48 jam
const RESET_TTL_SECONDS = 3600;          // tautan reset sandi: 60 menit

/** Buat + kirim tautan verifikasi email (dipakai register & resend). */
const sendVerificationEmail = async (env: Env, email: string, name: string): Promise<void> => {
  const token = randomToken();
  await env.KV.put(`email-verify:${token}`, JSON.stringify({ email }), { expirationTtl: VERIFY_TTL_SECONDS });
  const url = `${env.PUBLIC_APP_URL}/#/verifikasi-email?token=${token}`;
  await sendEmail(env, { to: email, subject: VERIFY_EMAIL_SUBJECT, html: verifyEmailTemplate({ name, url, expiresInHours: 48 }) });
};

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
  // Layanan email aktif → wajib konfirmasi email dulu (login diblokir);
  // tanpa key → langsung terverifikasi agar pendaftaran tetap bisa dipakai.
  const verified = emailConfigured(env) ? 0 : 1;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO orgs (id, name, slug, plan, plan_expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(orgId, orgName, slug, 'trial', trialEnd, nowISO()),
    env.DB.prepare('INSERT INTO users (email, org_id, name, role, password_hash, email_verified, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
      .bind(email, orgId, name, 'owner', await hashPassword(password), verified, nowISO()),
  ]);

  if (!verified) {
    // Jangan buat sesi: akun aktif setelah klik tautan aktivasi di email.
    await sendVerificationEmail(env, email, name);
    await audit(env, email, 'register-verify-sent', `org=${orgName}`);
    return json({ org: { id: orgId, name: orgName, slug, plan: 'trial', planExpiresAt: trialEnd }, email, name, role: 'owner', verificationRequired: true }, 201);
  }

  const token = await issueSession(env, { email, orgId, role: 'owner' });
  await audit(env, email, 'register', `org=${orgName}`);
  return json({ org: { id: orgId, name: orgName, slug, plan: 'trial', planExpiresAt: trialEnd }, email, name, role: 'owner', token }, 201, {
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
    'SELECT u.email, u.org_id, u.name, u.role, u.password_hash, u.email_verified, o.plan, o.plan_expires_at, o.suspended, o.name AS org_name, o.slug FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.email = ?1'
  ).bind(email).first<{
    email: string; org_id: string; name: string; role: string; password_hash: string; email_verified: number;
    plan: string; plan_expires_at: string | null; suspended: number; org_name: string; slug: string;
  }>();
  // Hash dummy untuk kesetaraan waktu (anti user-enumeration).
  // PENTING: iterasi ≤ 100.000 — WebCrypto Workers menolak di atasnya,
  // dan iterasi tak-valid melempar error (bukan sekadar mismatch).
  const hash = user?.password_hash || `pbkdf2$${PBKDF2_ITERATIONS}$AAAA$AAAA`;
  const ok = await verifyPassword(password, hash);
  if (!user || !ok) return err('Email atau kata sandi salah.', 401);
  // Organisasi ditangguhkan operator platform → login diblokir (403).
  if (user.suspended) return err('Akun organisasi ditangguhkan — hubungi penyedia layanan.', 403);
  // Email belum dikonfirmasi (pendaftaran mandiri saat layanan email aktif).
  if (user.email_verified === 0) {
    return err('Email belum diverifikasi — buka tautan aktivasi di kotak masuk Anda, atau minta kirim ulang email verifikasi.', 403);
  }

  const token = await issueSession(env, { email: user.email, orgId: user.org_id, role: user.role });
  await audit(env, email, 'login', '', clientIp(request));
  return json({
    email: user.email, name: user.name, role: user.role, token,
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
export const handleLogout = async (request: Request, env: Env): Promise<Response> => {
  await revokeRequestSessions(env, request);
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
};

/** POST /auth/verify-email — { token } dari tautan aktivasi.
 *  Publik; menandai users.email_verified = 1 lalu token dihapus (sekali pakai). */
export const handleVerifyEmail = async (request: Request, env: Env): Promise<Response> => {
  if (!(await rateLimit(env, `verify:${clientIp(request)}`, 20))) {
    return err('Terlalu sering — coba lagi nanti.', 429);
  }
  const body = await request.json().catch(() => null) as { token?: string } | null;
  const token = body?.token?.trim() || '';
  if (!token || token.length > 100) return err('Tautan verifikasi tidak valid.', 400);
  const raw = await env.KV.get(`email-verify:${token}`);
  if (!raw) return err('Tautan verifikasi kedaluwarsa — minta kirim ulang email aktivasi dari halaman masuk.', 400);
  let email = raw;
  try { email = (JSON.parse(raw) as { email?: string }).email || raw; } catch { /* nilai lama berupa email polos */ }
  await env.KV.delete(`email-verify:${token}`);
  const res = await env.DB.prepare('UPDATE users SET email_verified = 1 WHERE email = ?1 AND email_verified = 0')
    .bind(email).run();
  await audit(env, email, 'email-verified', (res.meta.changes ?? 0) > 0 ? '' : 'sudah-terverifikasi');
  return json({ ok: true, alreadyVerified: (res.meta.changes ?? 0) === 0 });
};

/** POST /auth/resend-verification — { email }.
 *  Selalu ok:true (anti user-enumeration); kirim ulang hanya bila akun
 *  ada, belum terverifikasi, dan layanan email aktif. */
export const handleResendVerification = async (request: Request, env: Env): Promise<Response> => {
  if (!(await rateLimit(env, `resend:${clientIp(request)}`, 5))) {
    return err('Terlalu sering — tunggu beberapa menit lagi.', 429);
  }
  const body = await request.json().catch(() => null) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase() || '';
  if (!email || !email.includes('@')) return err('Email wajib diisi.');
  const user = await env.DB.prepare('SELECT email, name, email_verified FROM users WHERE email = ?1')
    .bind(email).first<{ email: string; name: string; email_verified: number }>();
  if (user && user.email_verified === 0 && emailConfigured(env)) {
    await sendVerificationEmail(env, user.email, user.name);
    await audit(env, user.email, 'verify-resend', '');
  }
  return json({ ok: true });
};

/** POST /auth/forgot-password — { email }.
 *  Selalu ok:true bila layanan email aktif (anti enumerasi); tautan reset
 *  sekali-pakai 60 menit dikirim hanya ke email yang terdaftar. */
export const handleForgotPassword = async (request: Request, env: Env): Promise<Response> => {
  if (!(await rateLimit(env, `forgot:${clientIp(request)}`, 5))) {
    return err('Terlalu sering — tunggu beberapa menit lagi.', 429);
  }
  const body = await request.json().catch(() => null) as { email?: string } | null;
  const email = body?.email?.trim().toLowerCase() || '';
  if (!email || !email.includes('@')) return err('Email wajib diisi.');
  if (!emailConfigured(env)) {
    return err('Layanan email belum diaktifkan — hubungi admin organisasi untuk mengatur ulang kata sandi.', 503);
  }
  const user = await env.DB.prepare('SELECT email, name FROM users WHERE email = ?1')
    .bind(email).first<{ email: string; name: string }>();
  if (user) {
    const token = randomToken();
    await env.KV.put(`pw-reset:${token}`, JSON.stringify({ email: user.email }), { expirationTtl: RESET_TTL_SECONDS });
    const url = `${env.PUBLIC_APP_URL}/#/atur-ulang-sandi?token=${token}`;
    await sendEmail(env, {
      to: user.email, subject: RESET_PASSWORD_SUBJECT,
      html: resetPasswordTemplate({ name: user.name, url, expiresInMinutes: 60 }),
    });
    await audit(env, user.email, 'password-reset-request', '', clientIp(request));
  }
  return json({ ok: true });
};

/** POST /auth/reset-password — { token, newPassword }.
 *  Publik via tautan email; mengganti hash lalu token dihapus (sekali pakai). */
export const handleResetPassword = async (request: Request, env: Env): Promise<Response> => {
  if (!(await rateLimit(env, `pwreset:${clientIp(request)}`, 10))) {
    return err('Terlalu sering — coba lagi nanti.', 429);
  }
  const body = await request.json().catch(() => null) as { token?: string; newPassword?: string } | null;
  const token = body?.token?.trim() || '';
  const newPassword = body?.newPassword || '';
  if (!token || token.length > 100) return err('Tautan reset tidak valid.', 400);
  if (newPassword.length < 8 || newPassword.length > 128) return err('Kata sandi baru minimal 8 karakter (maksimal 128).');
  const raw = await env.KV.get(`pw-reset:${token}`);
  if (!raw) return err('Tautan reset kedaluwarsa — ajukan ulang "lupa kata sandi" dari halaman masuk.', 400);
  let email = raw;
  try { email = (JSON.parse(raw) as { email?: string }).email || raw; } catch { /* nilai lama berupa email polos */ }
  await env.KV.delete(`pw-reset:${token}`);
  const user = await env.DB.prepare('SELECT email, name FROM users WHERE email = ?1')
    .bind(email).first<{ email: string; name: string }>();
  if (!user) return err('Akun tidak ditemukan — hubungi admin organisasi.', 404);
  await env.DB.prepare('UPDATE users SET password_hash = ?1, email_verified = 1 WHERE email = ?2')
    .bind(await hashPassword(newPassword), user.email).run();
  await audit(env, user.email, 'password-reset', '');
  // Pemberitahuan keamanan (best-effort — kegagalan tidak membatalkan reset).
  await sendEmail(env, {
    to: user.email, subject: PASSWORD_CHANGED_SUBJECT,
    html: passwordChangedTemplate({ name: user.name, loginUrl: `${env.PUBLIC_APP_URL}/#/masuk` }),
  });
  return json({ ok: true });
};

/** POST /auth/exchange — tukar kode sekali-pakai (dari callback Google)
 *  menjadi sesi Bearer. Kode: KV TTL 2 menit, dihapus saat dibaca. */
export const handleExchange = async (request: Request, env: Env): Promise<Response> => {
  if (!(await rateLimit(env, `exchange:${clientIp(request)}`, 15))) {
    return err('Terlalu banyak percobaan — coba lagi nanti.', 429);
  }
  const body = await request.json().catch(() => null) as { code?: string } | null;
  const code = body?.code?.trim() || '';
  if (!code || code.length > 100) return err('Kode tidak valid.', 400);
  const token = await env.KV.get(`authcode:${code}`);
  if (!token) return err('Kode login kedaluwarsa — silakan login ulang.', 400);
  await env.KV.delete(`authcode:${code}`);
  const claims = await verifySession(env, token);
  if (!claims) return err('Sesi tidak valid — silakan login ulang.', 400);
  const meRes = await handleMe(env, claims);
  const meBody = await meRes.json() as Record<string, unknown>;
  return json({ ...meBody, token }, 200);
};

/** Preflight OPTIONS global (origin di-echo untuk request credentialed). */
export const preflight = (request: Request): Response =>
  new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
