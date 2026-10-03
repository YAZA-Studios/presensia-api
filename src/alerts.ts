// ─────────────────────────────────────────────────────────────
// Presensia — Runner alert harian (D1 + email).
// Aturan murni ada di src/domain/hr/alerts.ts; file ini hanya I/O:
//   1. Ambil kontrak berakhir (H-60/30/14) → email admin HR.
//   2. Sisa cuti terpakai nol → pengingat bulanan ke karyawan.
//   3. Digest liabilitas cuti bulanan ke admin.
// Semua idempotent lewat alert_log (PK org+kind+ref) — cron per jam aman.
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';
import { nowISO } from './http';
import { sendEmail, emailLayout, escapeHtml } from './email';
import {
  daysUntil, nearestMilestone, contractAlertRef, leaveReminderRef, leaveDigestRef,
  contractAlertSubject, leaveReminderSubject, leaveDigestSubject,
} from './domain/hr/alerts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const todayStr = (timezone: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** Sudah pernah terkirim? (dedupe) */
const alreadySent = async (env: Env, orgId: string, kind: string, ref: string): Promise<boolean> => {
  const row = await env.DB.prepare('SELECT ref FROM alert_log WHERE org_id = ?1 AND kind = ?2 AND ref = ?3')
    .bind(orgId, kind, ref).first();
  return !!row;
};

const markSent = async (env: Env, orgId: string, kind: string, ref: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO alert_log (org_id, kind, ref, sent_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(org_id, kind, ref) DO NOTHING`
  ).bind(orgId, kind, ref, nowISO()).run();
};

/** Admin HR (owner/admin) sebagai penerima alert kontrak & digest. */
const adminEmails = async (env: Env, orgId: string): Promise<string[]> => {
  const rows = await env.DB.prepare(
    "SELECT email FROM users WHERE org_id = ?1 AND role IN ('owner', 'admin')"
  ).bind(orgId).all<{ email: string }>();
  return rows.results.map((r) => r.email);
};

/** ── 1. Kontrak berakhir: H-60 / H-30 / H-14 ─────────────── */
export const alertExpiringContracts = async (env: Env, orgId: string, timezone: string): Promise<number> => {
  const today = todayStr(timezone);
  const rows = await env.DB.prepare(
    `SELECT u.email, u.name, u.contract_end_date, o.name AS org_name
     FROM users u JOIN orgs o ON o.id = u.org_id
     WHERE u.org_id = ?1 AND u.contract_end_date IS NOT NULL AND u.contract_end_date <> ''`
  ).bind(orgId).all<{ email: string; name: string; contract_end_date: string; org_name: string }>();
  const admins = await adminEmails(env, orgId);
  if (!admins.length) return 0;

  let sent = 0;
  for (const r of rows.results) {
    if (!DATE_RE.test(r.contract_end_date)) continue;
    const daysLeft = daysUntil(r.contract_end_date, today);
    const milestone = nearestMilestone(daysLeft);
    if (!milestone) continue; // belum ≤ 60 hari
    const ref = contractAlertRef(r.email, milestone);
    if (await alreadySent(env, orgId, 'contract-expiry', ref)) continue;

    const subject = contractAlertSubject({
      employeeName: r.name, employeeEmail: r.email,
      contractEndDate: r.contract_end_date, daysLeft, orgName: r.org_name,
    });
    const body = emailLayout(subject, `
      <p>Kontrak <strong>${escapeHtml(r.name)}</strong> (${escapeHtml(r.email)}) berakhir pada
      <strong>${escapeHtml(r.contract_end_date)}</strong> — ${daysLeft < 0 ? `sudah lewat ${Math.abs(daysLeft)} hari` : `${daysLeft} hari lagi`}.</p>
      <p>Silakan siapkan perpanjangan atau proses keluar sebagaimana mestinya.</p>
      <p><a href="${env.PUBLIC_APP_URL}/#/app" style="display:inline-block;background:#2E7D63;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">Buka Presensia</a></p>
    `);
    let anySent = false;
    for (const to of admins) {
      const res = await sendEmail(env, { to, subject, html: body });
      if (res.ok && !res.skipped) anySent = true;
    }
    // Tandai terkirim hanya bila benar-benar terkirim — saat key belum
    // dipasang (skipped) alert TIDAK dicatat, jadi begitu key tersedia
    // milestone yang tertunda langsung terkirim (dedupe tetap per ref).
    if (anySent) { await markSent(env, orgId, 'contract-expiry', ref); sent += 1; }
  }
  return sent;
};

/** ── 2. Pengingat cuti bulanan (sisa > 0) ─────────────────── */
export const alertUnusedLeave = async (env: Env, orgId: string, timezone: string): Promise<number> => {
  const month = todayStr(timezone).slice(0, 7);
  const year = Number(month.slice(0, 4));
  const quotaRow = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?1')
    .bind(`leave_quota:${orgId}`).first<{ value: string }>();
  const quotaN = quotaRow?.value ? Number(quotaRow.value) : NaN;
  const quota = Number.isFinite(quotaN) && quotaN > 0 ? Math.round(quotaN) : 12;

  const rows = await env.DB.prepare(
    `SELECT u.email, u.name, COALESCE(SUM(
       CASE WHEN l.status = 'approved' AND l.type = 'leave' AND l.date_from LIKE ?2 || '%' THEN
         (julianday(l.date_to) - julianday(l.date_from)) + 1 ELSE 0 END), 0) AS used
     FROM users u LEFT JOIN leave_requests l ON l.email = u.email
     WHERE u.org_id = ?1
     GROUP BY u.email`
  ).bind(orgId, String(year)).all<{ email: string; name: string; used: number }>();

  let sent = 0;
  for (const r of rows.results) {
    const used = Math.round(r.used);
    const remaining = quota - used;
    if (remaining <= 0) continue;                        // sudah terpakai habis / tidak ada sisa
    if (used > 0) continue;                              // sudah pakai cuti tahun ini → tidak diganggu
    const ref = leaveReminderRef(r.email, month);
    if (await alreadySent(env, orgId, 'leave-reminder', ref)) continue;

    const subject = leaveReminderSubject({
      employeeName: r.name, remainingDays: remaining, quotaDays: quota, year,
    });
    const body = emailLayout(subject, `
      <p>Halo <strong>${escapeHtml(r.name)}</strong>,</p>
      <p>Anda masih punya <strong>${remaining} hari</strong> cuti ${year} yang belum terpakai
      (kuota ${quota} hari, terpakai ${used}). Sisa cuti akan hangus di akhir periode — manfaatkan untuk istirahat.</p>
      <p><a href="${env.PUBLIC_APP_URL}/#/app" style="display:inline-block;background:#2E7D63;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">Ajukan Cuti</a></p>
    `);
    const res = await sendEmail(env, { to: r.email, subject, html: body });
    // key belum terpasang → TIDAK ditandai (akan terkirim saat key ada);
    // sukses → catat agar tidak dobel bulan ini.
    if (res.ok && !res.skipped) { await markSent(env, orgId, 'leave-reminder', ref); sent += 1; }
  }
  return sent;
};

/** ── 3. Digest liabilitas cuti bulanan untuk admin ────────── */
export const leaveDigest = async (env: Env, orgId: string, timezone: string): Promise<number> => {
  const today = todayStr(timezone);
  const month = today.slice(0, 7);
  const day = Number(today.slice(8, 10));
  // kirim sekali di awal bulan (tanggal 1–2 saja; selain itu lewati).
  if (day > 2) return 0;
  const year = Number(month.slice(0, 4));
  const quotaRow = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?1')
    .bind(`leave_quota:${orgId}`).first<{ value: string }>();
  const quotaN = quotaRow?.value ? Number(quotaRow.value) : NaN;
  const quota = Number.isFinite(quotaN) && quotaN > 0 ? Math.round(quotaN) : 12;

  const ref = leaveDigestRef(month);
  if (await alreadySent(env, orgId, 'leave-digest', ref)) return 0;

  const rows = await env.DB.prepare(
    `SELECT u.name, COALESCE(SUM(
       CASE WHEN l.status = 'approved' AND l.type = 'leave' AND l.date_from LIKE ?2 || '%' THEN
         (julianday(l.date_to) - julianday(l.date_from)) + 1 ELSE 0 END), 0) AS used
     FROM users u LEFT JOIN leave_requests l ON l.email = u.email
     WHERE u.org_id = ?1
     GROUP BY u.email HAVING used < ?3`
  ).bind(orgId, String(year), quota).all<{ name: string; used: number }>();
  if (!rows.results.length) return 0;

  const orgRow = await env.DB.prepare('SELECT name FROM orgs WHERE id = ?1').bind(orgId).first<{ name: string }>();
  const orgName = orgRow?.name ?? 'Organisasi';
  const employees = rows.results.map((r) => ({ name: r.name, remainingDays: quota - Math.round(r.used) }))
    .sort((a, b) => b.remainingDays - a.remainingDays).slice(0, 50);

  const subject = leaveDigestSubject({ month, orgName, employees });
  const body = emailLayout(subject, `
    <p>Berikut karyawan dengan sisa cuti belum terpakai per ${escapeHtml(month)} (potensi liabilitas cuti):</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">
      ${employees.map((e) => `<tr>
        <td style="padding:6px 8px;border-bottom:1px solid #E4EAF0;">${escapeHtml(e.name)}</td>
        <td style="padding:6px 8px;border-bottom:1px solid #E4EAF0;text-align:right;"><strong>${e.remainingDays}</strong> hari</td>
      </tr>`).join('')}
    </table>
    <p style="margin-top:16px;">Total: <strong>${employees.length}</strong> karyawan, total sisa
    <strong>${employees.reduce((a, e) => a + e.remainingDays, 0)}</strong> hari.</p>
    <p><a href="${env.PUBLIC_APP_URL}/#/app" style="display:inline-block;background:#2E7D63;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">Lihat Laporan</a></p>
  `, 'Digest liabilitas cuti bulanan dari Presensia.');

  const admins = await adminEmails(env, orgId);
  let anySent = false;
  for (const to of admins) {
    const res = await sendEmail(env, { to, subject, html: body });
    if (res.ok && !res.skipped) anySent = true;
  }
  if (anySent) { await markSent(env, orgId, 'leave-digest', ref); return 1; }
  return 0;
};

/** Jalankan semua alert untuk satu org (dipanggil cron per jam). */
export const runOrgAlerts = async (env: Env, orgId: string, timezone: string): Promise<void> => {
  try { await alertExpiringContracts(env, orgId, timezone); }
  catch (e) { console.error(`[alerts:contract] ${orgId}`, e); }
  try { await alertUnusedLeave(env, orgId, timezone); }
  catch (e) { console.error(`[alerts:leave] ${orgId}`, e); }
  try { await leaveDigest(env, orgId, timezone); }
  catch (e) { console.error(`[alerts:digest] ${orgId}`, e); }
};
