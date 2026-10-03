// ─────────────────────────────────────────────────────────────
// Presensia — Policy Engine per org (JSON di kolom orgs.policies).
// Aturan fleksibel tanpa rombak skema: lembur, istirahat, HR
// approval, GPS strict. Semua punya default aman.
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';
import { parseBpjsConfig, mergeBpjsConfig } from './domain/payroll/bpjs';
import { parseThrConfig, mergeThrConfig } from './domain/payroll/thr';
import type { BpjsConfig } from './domain/payroll/bpjs';
import type { ThrConfig } from './domain/payroll/thr';

export { JKK_RISK_CLASSES, DEFAULT_BPJS_CONFIG } from './domain/payroll/bpjs';
export type { BpjsConfig } from './domain/payroll/bpjs';
export { DEFAULT_THR_CONFIG } from './domain/payroll/thr';
export type { ThrConfig } from './domain/payroll/thr';

export interface OrgPolicy {
  timezone: string;                           // zona waktu org (kolom orgs.timezone, disertai di sini untuk UI)
  breakMinutes: number;                       // potongan otomatis per shift (default 60)
  overtime: {
    minMinutes: number;                       // < ini tidak dihitung (default 30)
    roundMinutes: number;                     // pembulatan ke atas (default 15)
    multiplierWeekday: number;                // default 1.5
    multiplierHoliday: number;                // default 2
  };
  leave: {
    hrApprovalOverDays: number;               // cuti > N hari → approval HR (default 3, 0 = off)
  };
  gps: {
    maxAccuracyM: number;                     // akurasi device di atas ini ditolak (default 100)
    strictIpCheck: boolean;                   // true = tolak bila IP↔koordinat jomplang (default false = flag saja)
  };
}

export const DEFAULT_POLICY: OrgPolicy = {
  timezone: 'Asia/Jakarta',
  breakMinutes: 60,
  overtime: { minMinutes: 30, roundMinutes: 15, multiplierWeekday: 1.5, multiplierHoliday: 2 },
  leave: { hrApprovalOverDays: 3 },
  gps: { maxAccuracyM: 100, strictIpCheck: false },
};

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;

export const parsePolicy = (raw: string | null): OrgPolicy => {
  if (!raw) return DEFAULT_POLICY;
  try {
    const p = JSON.parse(raw) as Partial<OrgPolicy>;
    return {
      timezone: typeof p.timezone === 'string' && p.timezone.trim() ? p.timezone.trim().slice(0, 40) : DEFAULT_POLICY.timezone,
      breakMinutes: num(p.breakMinutes, DEFAULT_POLICY.breakMinutes),
      overtime: {
        minMinutes: num(p.overtime?.minMinutes, DEFAULT_POLICY.overtime.minMinutes),
        roundMinutes: num(p.overtime?.roundMinutes, DEFAULT_POLICY.overtime.roundMinutes),
        multiplierWeekday: num(p.overtime?.multiplierWeekday, DEFAULT_POLICY.overtime.multiplierWeekday),
        multiplierHoliday: num(p.overtime?.multiplierHoliday, DEFAULT_POLICY.overtime.multiplierHoliday),
      },
      leave: { hrApprovalOverDays: num(p.leave?.hrApprovalOverDays, DEFAULT_POLICY.leave.hrApprovalOverDays) },
      gps: {
        maxAccuracyM: num(p.gps?.maxAccuracyM, DEFAULT_POLICY.gps.maxAccuracyM),
        strictIpCheck: p.gps?.strictIpCheck === true,
      },
    };
  } catch { return DEFAULT_POLICY; }
};

export const getPolicy = async (env: Env, orgId: string): Promise<OrgPolicy> => {
  const row = await env.DB.prepare('SELECT policies, timezone FROM orgs WHERE id = ?1').bind(orgId)
    .first<{ policies: string | null; timezone: string | null }>();
  return { ...parsePolicy(row?.policies ?? null), timezone: row?.timezone || DEFAULT_POLICY.timezone };
};

/** Admin/owner simpan policy (merge dengan default — anti field liar).
 *  timezone ikut disimpan ke kolom orgs.timezone (dipakai engine absensi). */
export const mergePolicy = async (env: Env, orgId: string, patch: Partial<OrgPolicy>): Promise<OrgPolicy> => {
  const current = await getPolicy(env, orgId);
  const next: OrgPolicy = {
    timezone: typeof patch.timezone === 'string' && patch.timezone.trim() ? patch.timezone.trim().slice(0, 40) : current.timezone,
    breakMinutes: num(patch.breakMinutes, current.breakMinutes),
    overtime: {
      minMinutes: num(patch.overtime?.minMinutes, current.overtime.minMinutes),
      roundMinutes: num(patch.overtime?.roundMinutes, current.overtime.roundMinutes),
      multiplierWeekday: num(patch.overtime?.multiplierWeekday, current.overtime.multiplierWeekday),
      multiplierHoliday: num(patch.overtime?.multiplierHoliday, current.overtime.multiplierHoliday),
    },
    leave: { hrApprovalOverDays: num(patch.leave?.hrApprovalOverDays, current.leave.hrApprovalOverDays) },
    gps: {
      maxAccuracyM: num(patch.gps?.maxAccuracyM, current.gps.maxAccuracyM),
      strictIpCheck: patch.gps?.strictIpCheck ?? current.gps.strictIpCheck,
    },
  };
  await env.DB.prepare(
    `UPDATE orgs SET policies = ?1, timezone = ?2 WHERE id = ?3`
  ).bind(JSON.stringify(next), next.timezone, orgId).run();
  return next;
};

/** ── Konfigurasi BPJS per org (app_config `bpjs:<orgId>`) ──────────
 *  Admin bisa ubah tarif, kelas risiko JKK, dan plafon TANPA deploy.
 *  Belum ada baris → default bawaan (parseBpjsConfig menangani null). */
export const getBpjsConfig = async (env: Env, orgId: string): Promise<BpjsConfig> => {
  const row = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?1')
    .bind(`bpjs:${orgId}`).first<{ value: string }>();
  return parseBpjsConfig(row?.value ?? null);
};

/** Simpan patch admin (merge + clamp) lalu tulis ke app_config. */
export const saveBpjsConfig = async (
  env: Env, orgId: string, patch: unknown,
): Promise<{ config: BpjsConfig; changed: boolean }> => {
  const current = await getBpjsConfig(env, orgId);
  const next = mergeBpjsConfig(current, patch);
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (changed) {
    await env.DB.prepare(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(`bpjs:${orgId}`, JSON.stringify(next)).run();
  }
  return { config: next, changed };
};

/** ── Konfigurasi THR per org (app_config `thr:<orgId>`) ──────────
 *  Kebijakan THR (masa kerja penuh, kelipatan gaji, minimum) bisa diubah
 *  admin tanpa deploy (BR-24). Belum ada baris → default BR-13. */
export const getThrConfig = async (env: Env, orgId: string): Promise<ThrConfig> => {
  const row = await env.DB.prepare('SELECT value FROM app_config WHERE key = ?1')
    .bind(`thr:${orgId}`).first<{ value: string }>();
  return parseThrConfig(row?.value ?? null);
};

/** Simpan patch admin THR (merge + clamp) lalu tulis ke app_config. */
export const saveThrConfig = async (
  env: Env, orgId: string, patch: unknown,
): Promise<{ config: ThrConfig; changed: boolean }> => {
  const current = await getThrConfig(env, orgId);
  const next = mergeThrConfig(current, patch);
  const changed = JSON.stringify(next) !== JSON.stringify(current);
  if (changed) {
    await env.DB.prepare(
      `INSERT INTO app_config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(`thr:${orgId}`, JSON.stringify(next)).run();
  }
  return { config: next, changed };
};

/** Apakah periode absensi bulan ini dikunci? (dipakai guard clock/koreksi/cron). */
export const isPeriodLocked = async (env: Env, orgId: string, month: string): Promise<boolean> => {
  const row = await env.DB.prepare('SELECT org_id FROM attendance_locks WHERE org_id = ?1 AND month = ?2')
    .bind(orgId, month).first();
  return !!row;
};

/** Apakah tanggal libur nasional? (baca policy kolom holidays JSON terpisah). */
export const isHoliday = async (env: Env, orgId: string, date: string): Promise<boolean> => {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = ?1")
    .bind(`holidays:${orgId}`).first<{ value: string }>();
  if (!row?.value) return false;
  try { return (JSON.parse(row.value) as string[]).includes(date); } catch { return false; }
};
