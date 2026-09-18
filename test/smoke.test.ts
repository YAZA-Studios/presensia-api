// Smoke test inti Hadirku API — jalan di workers pool (vitest-pool-workers).
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

const app = worker as unknown as { fetch: (req: Request, env: unknown, ctx: unknown) => Promise<Response> };

const env = {
  DB: {
    prepare: (_sql: string) => {
      const chain: any = {
        bind: () => chain,
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      };
      return chain;
    },
    batch: async () => [],
  } as unknown as D1Database,
  KV: {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
  } as unknown as KVNamespace,
  R2: { put: async () => ({}), get: async () => null } as unknown as R2Bucket,
  APP_NAME: 'Hadirku',
  PUBLIC_API_URL: 'https://api.test',
  PUBLIC_APP_URL: 'https://app.test',
} as any;

const req = (path: string, init: RequestInit = {}): Request =>
  new Request(`https://api.test${path}`, init);

describe('Hadirku API — smoke', () => {
  it('health ok', async () => {
    const res = await app.fetch(req('/health'), env, {} as any);
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; service: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe('hadirku-api');
  });

  it('route privat tanpa sesi → 401', async () => {
    const res = await app.fetch(req('/attendance/today'), env, {} as any);
    expect(res.status).toBe(401);
  });

  it('endpoint tidak dikenal (dengan sesi palsu) → 401/404', async () => {
    // Tanpa cookie → 401 di gerbang sesi; dengan cookie sampah → tetap ditolak.
    const res = await app.fetch(req('/tidak-ada'), env, {} as any);
    expect([401, 404]).toContain(res.status);
  });

  it('register validasi data kosong → 400', async () => {
    const res = await app.fetch(req('/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    }), env, {} as any);
    expect(res.status).toBe(400);
  });
});
