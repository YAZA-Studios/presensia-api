import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { createSessionService } from '../src/application/identity/session-service';
import { d1SessionRepository } from '../src/infrastructure/d1/sessions';
import { sessionTokenCodec } from '../src/infrastructure/crypto/session-token';
import { sessionFromRequest, revokeRequestSessions } from '../src/sessions';
import { handleLogout } from '../src/routes/auth';
import type { Env } from '../src/env';
import { SESSION_TTL_SECONDS } from '../src/domain/identity/session';

// Execute the actual migration and repository SQL against SQLite. The small
// binding adapter only translates D1's result shape, never emulates SQL rules.
describe('D1 session isolation and revocation (SQLite integration)', () => {
  let sql: DatabaseSync;
  let binding: Pick<D1Database, 'prepare'>;
  let clock: number;
  const owner = { email: 'owner@a.test', orgId: 'org-a', role: 'owner' };
  const other = { email: 'owner@b.test', orgId: 'org-b', role: 'owner' };
  const service = () => createSessionService(d1SessionRepository(binding), sessionTokenCodec, () => clock);
  const env = () => ({ DB: binding } as Env);

  beforeEach(() => {
    sql = new DatabaseSync(':memory:');
    sql.exec('PRAGMA foreign_keys = ON');
    for (const migration of ['0001_init.sql', '0002_enterprise.sql', '0003_suspension.sql', '0004_sessions.sql']) {
      sql.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
    for (const user of [owner, other]) {
      sql.prepare("INSERT INTO orgs (id, name, slug, created_at) VALUES (?, ?, ?, '2026-09-23')").run(user.orgId, user.orgId, user.orgId);
      sql.prepare("INSERT INTO users (email, org_id, name, role, password_hash, created_at) VALUES (?, ?, 'Owner', 'owner', 'unused', '2026-09-23')").run(user.email, user.orgId);
    }
    binding = {
      prepare(query: string) {
        const statement = sql.prepare(query);
        let params: Record<string, string | number | null> = {};
        const prepared = {
          bind(...values: (string | number | null)[]) {
            params = Object.fromEntries(values.map((value, index) => [String(index + 1), value]));
            return prepared;
          },
          async first() { return statement.get(params) ?? null; },
          async run() { return { success: true, meta: { changes: Number(statement.run(params).changes) } }; },
        };
        return prepared as unknown as D1PreparedStatement;
      },
    };
    clock = Date.now();
  });
  afterEach(() => sql.close());

  it('stores only a token hash and resolves the server membership', async () => {
    const token = await service().issue({ ...owner, role: 'invented-role' });
    expect(token).toMatch(/^ps1_[a-f0-9]{64}$/);
    const row = sql.prepare('SELECT * FROM sessions').get()!;
    expect(row.token_hash).not.toBe(token);
    expect(row.token_hash).toBe(await sessionTokenCodec.hash(token));
    expect(await service().verify(token)).toEqual(owner);
  });

  it('rejects a forged tenant on session creation and by foreign key', async () => {
    await expect(service().issue({ ...owner, orgId: other.orgId })).rejects.toThrow();
    expect(() => sql.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, NULL)').run('forged', other.orgId, owner.email, clock, clock + 1000)).toThrow();
  });

  it('revokes one session without affecting another tenant', async () => {
    const a = await service().issue(owner);
    const b = await service().issue(other);
    await service().revoke(a);
    expect(await service().verify(a)).toBeNull();
    expect(await service().verify(b)).toEqual(other);
  });

  it('rejects expired sessions at the exact expiry boundary', async () => {
    const token = await service().issue(owner);
    clock += SESSION_TTL_SECONDS * 1000;
    expect(await service().verify(token)).toBeNull();
  });

  it('reads a changed role immediately', async () => {
    const token = await service().issue(owner);
    sql.prepare("UPDATE users SET role = 'employee' WHERE email = ?").run(owner.email);
    expect(await service().verify(token)).toEqual({ ...owner, role: 'employee' });
  });

  it('rejects a suspended organization, including new sessions', async () => {
    const token = await service().issue(owner);
    sql.prepare('UPDATE orgs SET suspended = 1 WHERE id = ?').run(owner.orgId);
    expect(await service().verify(token)).toBeNull();
    await expect(service().issue(owner)).rejects.toThrow();
  });

  it('deletes sessions with their membership', async () => {
    const token = await service().issue(owner);
    sql.prepare('DELETE FROM users WHERE email = ?').run(owner.email);
    expect(await service().verify(token)).toBeNull();
    expect(sql.prepare('SELECT count(*) AS n FROM sessions').get()!.n).toBe(0);
  });

  it('rejects old stateless tokens and tampered random tokens', async () => {
    expect(await service().verify('old-payload.signature')).toBeNull();
    expect(await service().verify(sessionTokenCodec.generate())).toBeNull();
  });

  it('never falls back from an invalid bearer to a different cookie identity', async () => {
    const token = await service().issue(owner);
    const request = new Request('https://app.test/api/me', { headers: { Authorization: 'Bearer invalid', Cookie: `presensia_session=${token}` } });
    expect(await sessionFromRequest(env(), request)).toBeNull();
  });

  it('does not accept a cookie with a misleading name suffix', async () => {
    const token = await service().issue(owner);
    const request = new Request('https://app.test/api/me', { headers: { Cookie: `fake_presensia_session=${token}` } });
    expect(await sessionFromRequest(env(), request)).toBeNull();
  });

  it('logout revokes both request tokens and prevents browser caching', async () => {
    const bearer = await service().issue(owner);
    const cookie = await service().issue(owner);
    const request = new Request('https://app.test/api/logout', { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, Cookie: `other=x; presensia_session=${cookie}` } });
    const response = await handleLogout(request, env());
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await service().verify(bearer)).toBeNull();
    expect(await service().verify(cookie)).toBeNull();
    await expect(revokeRequestSessions(env(), request)).resolves.toBeUndefined();
  });
});
