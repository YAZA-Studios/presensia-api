// ─────────────────────────────────────────────────────────────
// Presensia — Policy Engine per org (JSON di kolom orgs.policies).
// Aturan fleksibel tanpa rombak skema: lembur, istirahat, HR
// approval, GPS strict. Semua punya default aman.
// ─────────────────────────────────────────────────────────────
import type { Env } from './env';

export interface OrgPolicy {
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
  const row = await env.DB.prepare('SELECT policies FROM orgs WHERE id = ?1').bind(orgId)
    .first<{ policies: string | null }>();
  return parsePolicy(row?.policies ?? null);
};

/** Admin/owner simpan policy (merge dengan default — anti field liar). */
export const mergePolicy = async (env: Env, orgId: string, patch: Partial<OrgPolicy>): Promise<OrgPolicy> => {
  const current = await getPolicy(env, orgId);
  const next: OrgPolicy = {
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
    `UPDATE orgs SET policies = ?1 WHERE id = ?2`
  ).bind(JSON.stringify(next), orgId).run();
  return next;
};

/** Apakah tanggal libur nasional? (baca policy kolom holidays JSON terpisah). */
export const isHoliday = async (env: Env, orgId: string, date: string): Promise<boolean> => {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = ?1")
    .bind(`holidays:${orgId}`).first<{ value: string }>();
  if (!row?.value) return false;
  try { return (JSON.parse(row.value) as string[]).includes(date); } catch { return false; }
};
