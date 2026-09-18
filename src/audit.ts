// ─────────────────────────────────────────────────────────────
// Presensia — audit log (D1). Fire-and-forget, tidak pernah menggagalkan request.
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';

export const audit = async (env: Env, actor: string, action: string, detail = '', ip = ''): Promise<void> => {
  try {
    await env.DB.prepare('INSERT INTO audit_log (actor, action, detail, ip) VALUES (?1, ?2, ?3, ?4)')
      .bind(actor.slice(0, 120), action.slice(0, 60), detail.slice(0, 500), ip.slice(0, 60)).run();
  } catch { /* audit tidak boleh memblokir */ }
};
