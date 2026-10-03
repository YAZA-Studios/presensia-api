// ─────────────────────────────────────────────────────────────
// Presensia — tagihan & langganan via GATEWAY TERPUSAT yaza-payments.
// Pola: invoice → VA (yaza-payments → DOKU) → callback HMAC → aktif.
// Presensia tidak berbicara langsung ke DOKU; tenant 'presensia'
// terdaftar di tabel tenants gateway (insert sekali oleh operator).
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err, nowISO } from '../http';
import { getDokuCreds, dokuNotifySignatureValid } from '../doku';
import { yazaCreateVirtualAccount, yazaConfigured, yazaPaymentMethods, yazaCallbackValid } from '../yazapay';
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

/** GET /billing — invoice org milik sesi (termasuk info VA). */
export const myInvoices = async ({ env, claims }: Ctx): Promise<Response> => {
  const rows = await env.DB.prepare(
    'SELECT id, plan, employee_quota, months, amount, status, method, created_at, paid_at, va_number, bank_label, how_to_pay_url FROM invoices WHERE org_id = ?1 ORDER BY created_at DESC LIMIT 100'
  ).bind(claims.orgId).all<Record<string, unknown>>();
  return json({ invoices: rows.results.map((r) => ({
    id: r.id, plan: r.plan, employeeQuota: r.employee_quota, months: r.months, amount: r.amount,
    status: r.status, method: r.method, createdAt: r.created_at, paidAt: r.paid_at,
    vaNumber: r.va_number, bankLabel: r.bank_label, howToPayUrl: r.how_to_pay_url,
  })) });
};

/** POST /billing/invoices — buat invoice paket + langsung buat Virtual Account
 *  lewat gateway terpusat yaza-payments (idempoten: klik ganda → VA sama). */
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
  // VA berlaku 3 hari (sama dengan kebijakan checkout lama).
  const pay = await yazaCreateVirtualAccount(env, {
    externalId: id,
    amount: plan.price,
    expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    customer: { name: user?.name || 'Pelanggan Presensia', email: claims.email },
  });
  if (!pay.ok) return json({ invoice: { id, amount: plan.price, status: 'unpaid' }, dokuError: pay.message }, pay.status === 503 ? 503 : 502);

  await env.DB.prepare(
    'UPDATE invoices SET payment_ref = ?1, va_number = ?2, bank_label = ?3, how_to_pay_url = ?4 WHERE id = ?5'
  ).bind(pay.payment.transactionId, pay.payment.virtualAccountNo, pay.payment.bankLabel, pay.payment.howToPayPage || null, id).run();

  return json({
    invoice: { id, amount: plan.price, status: 'unpaid' },
    payment: {
      virtualAccountNo: pay.payment.virtualAccountNo,
      bankLabel: pay.payment.bankLabel,
      expiredAt: pay.payment.expiredAt,
      howToPayPage: pay.payment.howToPayPage,
    },
    paymentUrl: pay.payment.howToPayPage,
  }, 201);
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

/** GET /billing/invoices/:id — polling status (milik org sendiri, termasuk VA). */
export const invoiceStatus = async (invoiceId: string, { env, claims }: Ctx): Promise<Response> => {
  const inv = await env.DB.prepare(
    'SELECT id, plan, amount, status, method, paid_at, va_number, bank_label, how_to_pay_url FROM invoices WHERE id = ?1 AND org_id = ?2'
  ).bind(invoiceId, claims.orgId).first<Record<string, unknown>>();
  if (!inv) return err('Invoice tidak ditemukan.', 404);
  return json({ invoice: { id: inv.id, plan: inv.plan, amount: inv.amount, status: inv.status, method: inv.method, paidAt: inv.paid_at, vaNumber: inv.va_number, bankLabel: inv.bank_label, howToPayUrl: inv.how_to_pay_url } });
};

/** POST /payments/yaza/callback — callback server-to-server dari yaza-payments
 *  saat VA dibayar (payload payment.paid, HMAC-SHA-512 terverifikasi). */
export const yazaNotify = async (request: Request, env: Env): Promise<Response> => {
  const raw = await request.text();
  const time = request.headers.get('X-Yaza-Timestamp') || '';
  const signature = request.headers.get('X-Yaza-Signature') || '';
  if (!(await yazaCallbackValid(env, time, signature, raw))) return err('Signature tidak valid', 401);

  let body: { type?: string; externalId?: string; transactionId?: string; amount?: number; paidAt?: string };
  try { body = JSON.parse(raw); } catch { return err('Body bukan JSON', 400); }
  if (body.type !== 'payment.paid') return json({ ok: true, ignored: body.type || 'unknown' });

  const externalId = body.externalId || '';
  if (!externalId) return err('externalId tidak ada', 400);
  const invoice = await env.DB.prepare('SELECT id, amount, status, org_id FROM invoices WHERE id = ?1')
    .bind(externalId).first<{ id: string; amount: number; status: string; org_id: string }>();
  // Invoice tak dikenal → 200 agar gateway tidak mengulang tanpa akhir.
  if (!invoice) return json({ ok: true, ignored: 'invoice-tidak-ditemukan' });

  const amount = Number(body.amount || 0);
  if (amount && amount !== invoice.amount) {
    await audit(env, 'yaza-gateway', 'notify-mismatch', `${invoice.id} ${amount}!=${invoice.amount}`);
    return json({ ok: true, ignored: 'nominal-tidak-cocok' });
  }

  if (invoice.status !== 'paid') {
    await activatePaidInvoice(env, invoice.id);
    await audit(env, 'yaza-gateway', 'yaza-paid', `${invoice.id} org=${invoice.org_id} ${amount}`);
  }
  return json({ ok: true });
};

/**
 * GET /admin/doku — status gateway pembayaran terpusat (owner-only, READ-ONLY).
 * Semua pembayaran Yaza Studios lewat yaza-payments; kredensial DOKU tinggal
 * di gateway. Yang dibutuhkan tenant ini: API key layanan + tenant terdaftar.
 */
export const dokuStatus = async ({ env, claims }: Ctx): Promise<Response> => {
  if (claims.role !== 'owner') return err('Hanya owner.', 403);
  const configured = yazaConfigured(env);
  const channels = configured ? await yazaPaymentMethods(env) : [];
  return json({
    configured: configured && channels.length > 0,
    provider: 'yaza-payments',
    env: 'production',
    clientIdMasked: channels.length
      ? `${channels[0]!.label}${channels.length > 1 ? ` +${channels.length - 1} lain` : ''}`
      : null,
  });
};
