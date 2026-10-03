// Composition and HTTP compatibility entry point for D1-backed sessions.
import type { Env } from './env';
import { SESSION_TTL_SECONDS, type SessionClaims } from './domain/identity/session';
import { createSessionService } from './application/identity/session-service';
import { d1SessionRepository } from './infrastructure/d1/sessions';
import { sessionTokenCodec } from './infrastructure/crypto/session-token';
export type { SessionClaims } from './domain/identity/session';

const COOKIE_NAME = 'presensia_session';
const service = (env: Env) => createSessionService(d1SessionRepository(env.DB), sessionTokenCodec);
export const issueSession = (env: Env, claims: SessionClaims): Promise<string> => service(env).issue(claims);
export const verifySession = (env: Env, token: string | null | undefined): Promise<SessionClaims | null> => service(env).verify(token);

const cookieToken = (request: Request): string | null => {
  const match = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)presensia_session=([^;]*)/);
  return match?.[1] || null;
};
const bearerToken = (request: Request): string | null => {
  return request.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] || null;
};
export const sessionFromRequest = (env: Env, request: Request): Promise<SessionClaims | null> => {
  // Invalid explicit bearer must not silently become another cookie identity.
  const token = request.headers.has('Authorization') ? bearerToken(request) : cookieToken(request);
  return verifySession(env, token);
};
export const revokeRequestSessions = async (env: Env, request: Request): Promise<void> => {
  for (const token of new Set([bearerToken(request), cookieToken(request)])) await service(env).revoke(token);
};
export const sessionCookie = (token: string): string =>
  `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
export const clearSessionCookie = (): string =>
  `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
