// ─────────────────────────────────────────────────────────────
// Hadirku — sesi stateless cookie bertanda tangan HMAC-SHA256.
// Payload base64url: e=email, o=orgId, r=role, exp=epoch detik.
// Zero KV read per request; secret di KV (provision otomatis).
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';

const COOKIE_NAME = 'hadirku_session';
const TTL_S = 60 * 60 * 24 * 7; // 7 hari
const enc = new TextEncoder();

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const hmac = async (secret: string, data: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
};

const getSigningSecret = async (env: Env): Promise<string> => {
  if (env.SESSION_SIGNING_SECRET) return env.SESSION_SIGNING_SECRET;
  const existing = await env.KV.get('sec:session_signing');
  if (existing) return existing;
  const secret = crypto.randomUUID() + crypto.randomUUID();
  await env.KV.put('sec:session_signing', secret);
  return secret;
};

export interface SessionClaims { email: string; orgId: string; role: string }

export const issueSession = async (env: Env, claims: SessionClaims): Promise<string> => {
  const payload = b64url(enc.encode(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + TTL_S })));
  const sig = await hmac(await getSigningSecret(env), payload);
  return `${payload}.${sig}`;
};

export const verifySession = async (env: Env, token: string | null | undefined): Promise<SessionClaims | null> => {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(await getSigningSecret(env), payload);
  if (sig !== expected) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as SessionClaims & { exp: number };
    if (!json.exp || json.exp * 1000 < Date.now()) return null;
    return { email: json.email, orgId: json.orgId, role: json.role };
  } catch { return null; }
};

export const sessionFromRequest = async (env: Env, request: Request): Promise<SessionClaims | null> => {
  const cookie = request.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return verifySession(env, m?.[1]);
};

export const sessionCookie = (token: string): string =>
  `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL_S}`;

export const clearSessionCookie = (): string =>
  `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
