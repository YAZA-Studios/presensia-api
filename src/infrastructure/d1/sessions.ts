import type { SessionRepository } from '../../application/ports/session-repository';
import type { SessionClaims } from '../../domain/identity/session';

export function d1SessionRepository(db: Pick<D1Database, 'prepare'>): SessionRepository {
  // D1 queries without withSession() use the primary, even with read replication.
  // Authorization must not use KV or stale read replicas.
  return {
    async insert(session) {
      const result = await db.prepare(`
        INSERT INTO sessions (token_hash, org_id, user_email, created_at, expires_at)
        SELECT ?1, u.org_id, u.email, ?4, ?5 FROM users u
        JOIN orgs o ON o.id = u.org_id
        WHERE u.org_id = ?2 AND u.email = ?3 AND o.suspended = 0
      `).bind(session.tokenHash, session.orgId, session.email, session.createdAt, session.expiresAt).run();
      if (result.meta.changes !== 1) throw new Error('Cannot issue session for inactive membership');
    },
    async findActive(tokenHash, now) {
      return db.prepare(`
        SELECT u.email, u.org_id AS orgId, u.role FROM sessions s
        JOIN users u ON u.email = s.user_email AND u.org_id = s.org_id
        JOIN orgs o ON o.id = s.org_id
        WHERE s.token_hash = ?1 AND s.revoked_at IS NULL
          AND s.expires_at > ?2 AND o.suspended = 0
      `).bind(tokenHash, now).first<SessionClaims>();
    },
    async revoke(tokenHash, now) {
      await db.prepare('UPDATE sessions SET revoked_at = ?2 WHERE token_hash = ?1 AND revoked_at IS NULL')
        .bind(tokenHash, now).run();
    },
  };
}
