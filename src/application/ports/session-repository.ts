import type { NewSession, SessionClaims } from '../../domain/identity/session';
export interface SessionRepository {
  insert(session: NewSession): Promise<void>;
  findActive(tokenHash: string, now: number): Promise<SessionClaims | null>;
  revoke(tokenHash: string, now: number): Promise<void>;
}
export interface SessionTokenCodec {
  generate(): string;
  accepts(token: string): boolean;
  hash(token: string): Promise<string>;
}
