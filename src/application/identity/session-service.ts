import { SESSION_TTL_SECONDS, type SessionClaims } from '../../domain/identity/session';
import type { SessionRepository, SessionTokenCodec } from '../ports/session-repository';

export function createSessionService(repository: SessionRepository, codec: SessionTokenCodec, now = Date.now) {
  return {
    async issue(claims: SessionClaims): Promise<string> {
      const token = codec.generate();
      const createdAt = now();
      await repository.insert({
        tokenHash: await codec.hash(token), email: claims.email, orgId: claims.orgId,
        createdAt, expiresAt: createdAt + SESSION_TTL_SECONDS * 1000,
      });
      return token;
    },
    async verify(token: string | null | undefined): Promise<SessionClaims | null> {
      if (!token || !codec.accepts(token)) return null;
      return repository.findActive(await codec.hash(token), now());
    },
    async revoke(token: string | null | undefined): Promise<void> {
      if (token && codec.accepts(token)) await repository.revoke(await codec.hash(token), now());
    },
  };
}
