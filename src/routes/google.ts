// ─────────────────────────────────────────────────────────────
// Presensia — Login dengan Google (OAuth 2.0 + OIDC).
//
// Alur:
//   1. GET /auth/google            → 302 ke Google + state acak (KV, 10 mnt)
//   2. Google → GET /auth/google/callback?code&state
//   3. Server tukar code → token, verifikasi ID token (JWKS RS256),
//      buat/ambil user + org, terbitkan sesi cookie, 302 ke app.
//
// PKCE-less flow standar web app: client secret disimpan sebagai
// Worker secret (GOOGLE_CLIENT_SECRET). Setup:
//   npx wrangler secret put GOOGLE_CLIENT_ID
//   npx wrangler secret put GOOGLE_CLIENT_SECRET
// Redirect URI yang didaftarkan di Google Cloud Console:
//   https://api.presensia.id/auth/google/callback
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, nowISO } from '../http';
import { audit } from '../audit';
import { sessionCookie, issueSession } from '../sessions';

const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';

interface GoogleClaims {
  email: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  sub: string;
  aud: string;
  exp: number;
  iss: string;
}

const b64urlJson = (s: string): unknown =>
  JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')));

/** Verifikasi ID token Google: tanda tangan RS256 lewat JWKS, aud & iss & exp. */
export const verifyGoogleIdToken = async (idToken: string, clientId: string): Promise<GoogleClaims | null> => {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const header = b64urlJson(parts[0]) as { alg: string; kid: string };
  if (header.alg !== 'RS256') return null;

  const jwks = await fetch(GOOGLE_JWKS).then((r) => r.json()) as {
    keys: { kid: string; kty: string; n: string; e: string }[];
  };
  const jwk = jwks.keys.find((k) => k.kid === header.kid && k.kty === 'RSA');
  if (!jwk) return null;

  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const sigB64 = parts[2].replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(parts[2].length / 4) * 4, '=');
  const sig = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true } as JsonWebKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify'],
  );
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig as BufferSource, data as BufferSource))) return null;

  const claims = b64urlJson(parts[1]) as GoogleClaims;
  const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issOk || claims.aud !== clientId) return null;
  if (claims.exp * 1000 < Date.now()) return null;
  return claims;
};

/** GET /auth/google — mulai OAuth: redirect ke Google. */
export const googleStart = async (request: Request, env: Env): Promise<Response> => {
  const clientId = env.GOOGLE_CLIENT_ID;
  if (!clientId) return json({ error: 'Login Google belum dikonfigurasi.' }, 503);
  const origin = new URL(request.url).origin;
  const state = crypto.randomUUID();
  await env.KV.put(`oauth:state:${state}`, origin, { expirationTtl: 600 });
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', `${origin}/auth/google/callback`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
};

/** Buat org baru + owner dari akun Google (org baru mendaftar via Google). */
const provisionGoogleUser = async (env: Env, claims: GoogleClaims): Promise<{ email: string; orgId: string; role: string; isNew: boolean }> => {
  const existing = await env.DB.prepare('SELECT email, org_id, role FROM users WHERE email = ?1')
    .bind(claims.email).first<{ email: string; org_id: string; role: string }>();
  if (existing) return { email: existing.email, orgId: existing.org_id, role: existing.role, isNew: false };

  // Org baru: trial 14 hari.
  const orgId = crypto.randomUUID();
  const orgName = `${claims.name?.split(' ')[0] || 'Tim'} — Org`;
  let slug = (claims.name || 'org').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'org';
  const slugTaken = await env.DB.prepare('SELECT id FROM orgs WHERE slug = ?1').bind(slug).first();
  if (slugTaken) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  const trialEnd = new Date(Date.now() + 14 * 86_400_000).toISOString();
  const avatarPath = claims.picture ? `avatars/${orgId}/owner.jpg` : null;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO orgs (id, name, slug, plan, plan_expires_at, created_at) VALUES (?1, ?2, ?3, ?, ?4, ?5)')
      .bind(orgId, orgName, slug, 'trial', trialEnd, nowISO()),
    env.DB.prepare('INSERT INTO users (email, org_id, name, role, password_hash, avatar_path, created_at) VALUES (?1, ?2, ?3, ?, ?4, ?5, ?6)')
      .bind(claims.email, orgId, claims.name || claims.email, 'owner', `google:${claims.sub}`, avatarPath, nowISO()),
  ]);
  // Simpan avatar URL (bukan file) ke app_config agar ringan.
  if (claims.picture) {
    await env.DB.prepare(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = datetime('now')`
    ).bind(`avatar:${claims.email}`, claims.picture).run().catch(() => {});
  }
  return { email: claims.email, orgId, role: 'owner', isNew: true };
};

/** GET /auth/google/callback — tukar code, verifikasi, terbitkan sesi. */
export const googleCallback = async (request: Request, env: Env): Promise<Response> => {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return json({ error: 'Login Google belum dikonfigurasi.' }, 503);

  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  const stateOrigin = await env.KV.get(`oauth:state:${state}`);
  await env.KV.delete(`oauth:state:${state}`);
  if (!code || !stateOrigin) return json({ error: 'Sesi login Google kedaluwarsa — coba lagi.' }, 400);

  const tokenRes = await fetch(GOOGLE_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${stateOrigin}/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenRes.ok) return json({ error: 'Gagal menukar kode Google.' }, 502);
  const tokens = await tokenRes.json() as { id_token?: string };
  if (!tokens.id_token) return json({ error: 'Google tidak mengembalikan ID token.' }, 502);

  const claims = await verifyGoogleIdToken(tokens.id_token, clientId);
  if (!claims) return json({ error: 'ID token Google tidak valid.' }, 401);
  if (claims.email_verified === false) return json({ error: 'Email Google belum terverifikasi.' }, 403);

  const user = await provisionGoogleUser(env, claims);
  await audit(env, user.email, user.isNew ? 'register-google' : 'login-google', `sub=${claims.sub}`);
  const token = await issueSession(env, { email: user.email, orgId: user.orgId, role: user.role });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${stateOrigin}/#/app`,
      'Set-Cookie': sessionCookie(token),
    },
  });
};
