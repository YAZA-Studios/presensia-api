export interface SessionClaims { email: string; orgId: string; role: string }
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export interface NewSession {
  tokenHash: string;
  email: string;
  orgId: string;
  createdAt: number;
  expiresAt: number;
}
