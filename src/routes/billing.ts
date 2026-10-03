// ─────────────────────────────────────────────────────────────
// Presensia — tagihan & langganan (DOKU Checkout).
// Pola: invoice → checkout DOKU → notify (signature) → aktif.
// Kredensial DOKU diatur operator via `wrangler secret put` — bukan dari UI.
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err, nowISO } from '../http';
import { createDokuCheckout, getDokuCreds, dokuNotifySignatureValid, type DokuEnv } from '../doku';
import { audit } from '../audit';
import type { SessionClaims } from '../sessions';

interface Ctx { env: Env; claims: SessionClaims; request?: Request }

/** Katalog paket (dinamis dari app_config; fallback bawaan). */
interface Plan { id: string; name: string; price: number; employeeQuota: number; months: number }

const DEFAULT_PLANS: Plan[] = [
  { id: 'basic', name: 'Basic', price: 149_000, employeeQuota: 25, months: 1 },
  { id: 'pro', name: 'Pro', price: 1_290_000, employeeQuota: 200, months: 12 },
];

export const getPlans = async (env: Env): Promise<Plan[]> => {
  try {
    const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'plans'").first<{ value: string }>();
    if (row?.value) {
      const parsed = JSON.parse(row.value) as Plan[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch { /* fallback */ }
  return DEFAULT_PLANS;
};

/** GET /plans — katalog publik untuk landing. */
export const publicPlans = async ({ env }: Ctx): Promise<Response> => json({ plans: await getPlans(env) });

/** GET /billing — invoice org milik sesi. */
export const myInvoices = async ({ env, claims }: Ctx): Promise<Response> => {
  const rows = await env.DB.prepare(
    'SELECT id, plan, employee_quota, months, amount, status, method, created_at, paid_at FROM invoices WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 100'
  ).bind(claims.orgId).all<Record<string, unknown>>();
  return json({ invoices: rows.results.map((r) => ({
    id: r.id, plan: r.plan, employeeQuota: r.employee_quota, months: r.months, amount: r.amount,
    status: r.status, method: r.method, createdAt: r.created_at, paidAt: r.paid_at,
  })) });
};

/** POST /billing/invoices — buat invoice paket + langsung checkout DOKU. */
export const createInvoice = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  if (claims.role === 'employee') return err('Hanya admin/owner.', 403);
  const body = await request.json().catch(() => null) as { planId?: string; method?: string } | null;
  const planId = body?.planId || '';
  const plans = await getPlans(env);
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return err('Paket tidak ditemukan.', 404);

  const id = `INV-${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  await env.DB.prepare(
    'INSERT INTO invoices (id, org_id, plan, employee_quota, months, amount, status, method, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
  ).bind(id, claims.orgId, plan.id, plan.employeeQuota, plan.months, plan.price, 'unpaid', 'doku', nowISO()).run();
  await audit(env, claims.email, 'create-invoice', `${id} ${plan.id} ${plan.price}`);

  const user = await env.DB.prepare('SELECT name FROM users WHERE email = ?1').bind(claims.email).first<{ name: string }>();
  const checkout = await createDokuCheckout(env, { id, amount: plan.price }, { customerEmail: claims.email, customerName: user?.name || 'Pelanggan Presensia' });
  if (!checkout.ok) return json({ invoice: { id, amount: plan.price, status: 'unpaid' }, dokuError: checkout.message }, 502);
  return json({ invoice: { id, amount: plan.price, status: 'unpaid' }, paymentUrl: checkout.url }, 201);
};

/** Aktivasi invoice lunas — idempoten: perpanjang plan_expires_at org. */
export const activatePaidInvoice = async (env: Env, invoiceId: string): Promise<void> => {
  const inv = await env.DB.prepare('SELECT org_id, months, plan, status FROM invoices WHERE id = ?1').bind(invoiceId)
    .first<{ org_id: string; months: number; plan: string; status: string }>();
  if (!inv || inv.status === 'paid') return;
  const org = await env.DB.prepare('SELECT plan_expires_at FROM orgs WHERE id = ?1').bind(inv.org_id)
    .first<{ plan_expires_at: string | null }>();
  const base = org?.plan_expires_at && new Date(org.plan_expires_at).getTime() > Date.now()
    ? new Date(org.plan_expires_at).getTime() : Date.now();
  const newExpiry = new Date(base + inv.months * 30 * 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE invoices SET status = 'paid', paid_at = ?1 WHERE id = ?2").bind(nowISO(), invoiceId),
    env.DB.prepare('UPDATE orgs SET plan = ?1, plan_expires_at = ?2 WHERE id = ?3').bind(inv.plan, newExpiry, inv.org_id),
  ]);
};

/** POST /payments/doku/notify — server-to-server DOKU (signature diverifikasi). */
export const dokuNotify = async (request: Request, env: Env): Promise<Response> => {
  const clientId = request.headers.get('Client-Id') || '';
  const requestId = request.headers.get('Request-Id') || '';
  const timestamp = request.headers.get('Request-Timestamp') || '';
  const signature = request.headers.get('Signature') || '';

  const creds = await getDokuCreds(env);
  if (!creds) return err('DOKU belum dikonfigurasi', 503);
  const rawBody = await request.text();
  const notifyTarget = new URL(request.url).pathname;
  if (!(await dokuNotifySignatureValid(creds.clientId, requestId, timestamp, notifyTarget, rawBody, creds.secretKey, signature))) {
    return err('Signature tidak valid', 401);
  }
  if (clientId !== creds.clientId) return err('Client-Id tidak cocok', 401);

  let body: { order?: { invoice_number?: string; amount?: number }; transaction?: { status?: string } };
  try { body = JSON.parse(rawBody); } catch { return err('Body bukan JSON', 400); }
  const invoiceNumber = body.order?.invoice_number || '';
  if (!invoiceNumber) return err('invoice_number tidak ada', 400);

  const invoice = await env.DB.prepare('SELECT id, amount, status, org_id FROM invoices WHERE id = ?1').bind(invoiceNumber)
    .first<{ id: string; amount: number; status: string; org_id: string }>();
  if (!invoice) return err('Invoice tidak ditemukan', 404);
  const amount = Number(body.order?.amount || 0);
  if (amount && amount !== invoice.amount) {
    await audit(env, 'doku-gateway', 'notify-mismatch', `${invoiceNumber} ${amount}!=${invoice.amount}`);
    return err('Nominal tidak cocok dengan invoice', 400);
  }

  const status = String(body.transaction?.status || '').toUpperCase();
  if (['SUCCESS', 'COMPLETED', 'CAPTURED', 'PAID'].includes(status)) {
    if (invoice.status !== 'paid') {
      await activatePaidInvoice(env, invoiceNumber);
      await audit(env, 'doku-gateway', 'doku-paid', `${invoiceNumber} org=${invoice.org_id} ${amount}`);
    }
    await env.KV.delete(`dokuurl:${invoiceNumber}`);
    return json({ ok: true }, 200);
  }
  if (status === 'EXPIRED' || status === 'FAILED') {
    await audit(env, 'doku-gateway', `doku-${status.toLowerCase()}`, invoiceNumber);
  }
  return json({ ok: true, ignored: status || 'unknown' }, 200);
};

/** GET /billing/invoices/:id — polling status (milik org sendiri). */
export const invoiceStatus = async (invoiceId: string, { env, claims }: Ctx): Promise<Response> => {
  const inv = await env.DB.prepare('SELECT id, plan, amount, status, method, paid_at FROM invoices WHERE id = ?1 AND org_id = ?2')
    .bind(invoiceId, claims.orgId).first<Record<string, unknown>>();
  if (!inv) return err('Invoice tidak ditemukan.', 404);
  return json({ invoice: { id: inv.id, plan: inv.plan, amount: inv.amount, status: inv.status, method: inv.method, paidAt: inv.paid_at } });
};

/**
 * GET /admin/doku — status kredensial (owner-only, READ-ONLY).
 * Kredensial DOKU adalah rahasia operator platform: diatur lewat CLI
 * (`wrangler secret put`), tidak pernah dari dalam aplikasi.
 */
export const dokuStatus = async ({ env, claims }: Ctx): Promise<Response> => {
  if (claims.role !== 'owner') return err('Hanya owner.', 403);
  const creds = await getDokuCreds(env);
  const envMode: DokuEnv = (env.DOKU_ENV === 'production' ? 'production' : 'sandbox');
  return json({
    configured: !!creds,
    env: envMode,
    clientIdMasked: creds ? `${creds.clientId.slice(0, 4)}••••${creds.clientId.slice(-2)}` : null,
  });
};
