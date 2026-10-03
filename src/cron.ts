// ─────────────────────────────────────────────────────────────
// Presensia — Cron Worker (per jam):
//  1. Tandai ABSENT karyawan yang tidak clock-in sampai akhir hari+grace
//     (karena zona waktu beragam, jalankan tiap jam & filter per org).
//  2. Nonaktifkan org trial/paket kedaluwarsa (plan tetap, gate di runtime).
//  3. Bersihkan rate_limit_hits window kemarin.
//  4. Alert HR harian (jam 09:00 lokal per org): kontrak H-60/30/14,
//     pengingat cuti bulanan, digest liabilitas cuti — idempotent via
//     alert_log + email Brevo (no-op sampai key dipasang).
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';
import { workDateIn } from './geo';
import { isPeriodLocked } from './policies';
import { runOrgAlerts } from './alerts';
import { yazaUrl, yazaConfigured } from './yazapay';

const ALERT_HOUR = 9; // jam lokal per org alert harian dikirim

export const runScheduled = async (env: Env): Promise<void> => {
  const now = new Date();
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(now.getTime()).run();

  // 3) Bersihkan rate limit (window > 1 jam).
  await env.DB.prepare("DELETE FROM rate_limit_hits WHERE window_start < ?1")
    .bind(new Date(now.getTime() - 3_600_000).toISOString()).run().catch(() => {});

  // 1) Absent: org yang jam lokalnya sudah >= 23:00 → hari selesai.
  // 4) Alert HR: org yang jam lokalnya tepat ALERT_HOUR (09:00) → kirim alert.
  const orgs = await env.DB.prepare('SELECT id, timezone FROM orgs').all<{ id: string; timezone: string }>();
  for (const org of orgs.results) {
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: org.timezone, hour: '2-digit', hour12: false }).format(now));

    if (hour === ALERT_HOUR) await runOrgAlerts(env, org.id, org.timezone);

    if (hour < 23) continue;
    const d = workDateIn(org.timezone, now);
    // Periode sudah dikunci untuk payroll → jangan tambah baris 'absent' baru
    // (perubahan hanya boleh lewat koreksi berpersetujuan).
    if (await isPeriodLocked(env, org.id, d.slice(0, 7))) continue;
    // Karyawan aktif yang belum punya baris attendance hari ini → absent.
    await env.DB.prepare(
      `INSERT INTO attendance (id, org_id, email, work_date, status, note, created_at)
       SELECT lower(hex(randomblob(16))), u.org_id, u.email, ?2, 'absent', 'otomatis (cron)', datetime('now')
       FROM users u WHERE u.org_id = ?1
       AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.email = u.email AND a.work_date = ?2)
       AND NOT EXISTS (SELECT 1 FROM leave_requests l WHERE l.email = u.email AND l.status = 'approved'
                       AND l.date_from <= ?2 AND l.date_to >= ?2)`
    ).bind(org.id, d).run().catch(() => {});
  }

  // 5) Maintenance gateway terpusat yaza-payments: reconcile status VA
  //    pending + retry callback yang gagal (cron tenant, tanpa trigger baru).
  if (yazaConfigured(env)) {
    await fetch(`${yazaUrl(env)}/internal/maintenance`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.YAZA_PAYMENTS_API_KEY}` },
    }).catch(() => {});
  }
};
