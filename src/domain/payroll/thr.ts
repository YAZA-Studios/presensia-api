// ─────────────────────────────────────────────────────────────
// Presensia — THR (Tunjangan Hari Raya) calculator (murni, tanpa I/O).
//
// Dasar: BR-13 / Permenaker 6/2016 — THR = 1 (satu) bulan gaji bagi
// pekerja dengan masa kerja ≥ 12 bulan; masa kerja < 12 bulan dibayar
// PROPORSIONAL: (masa kerja bulan penuh ÷ 12) × 1 bulan gaji.
// Pekerja dengan masa kerja ≥ 1 bulan sudah berhak THR (maka default
// minMonths = 1). Upah acuan = gaji pokok/upah bulanan terakhir.
//
// Semua angka adalah KONFIGURASI (prinsip BR-24): kebijakan perusahaan
// (mis. THR 2 bulan gaji) diubah lewat config, bukan kode.
// Perhatian: tanggal masuk kerja WAJIB diisi (users.hire_date) — tanpa itu
// masa kerja tidak diketahui dan karyawan tidak dihitung (ada alasan di
// `reason`, admin bisa lihat di run THR).
// ─────────────────────────────────────────────────────────────

export interface ThrConfig {
  monthsForFull: number;   // masa kerja penuh (default 12 — BR-13)
  multiplier: number;      // kelipatan gaji pokok (default 1 = satu bulan gaji)
  minMonths: number;       // masa kerja minimum berhak (default 1 — Permenaker 6/2016)
}

export const DEFAULT_THR_CONFIG: ThrConfig = {
  monthsForFull: 12,
  multiplier: 1,
  minMonths: 1,
};

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const daysInMonth = (y: number, m: number): number => new Date(y, m, 0).getDate();

/** Masa kerja dalam BULAN PENUH dari hireDate s/d refDate.
 *  Ulang tahun tanggal yang tidak ada di bulan tujuan dianggap tanggal
 *  terakhir bulan itu (KUHPerdata pasal 124) — mis. 29 Feb → 28 Feb = setahun.
 *  Format rusak / refDate sebelum hireDate → 0. */
export const tenureMonths = (hireDate: string, refDate: string): number => {
  if (!dateRe.test(hireDate) || !dateRe.test(refDate) || refDate < hireDate) return 0;
  const [hy, hm, hd] = hireDate.split('-').map(Number);
  const [ry, rm, rd] = refDate.split('-').map(Number);
  const months = (ry - hy) * 12 + (rm - hm);
  // Batas hari ulang tahun di bulan acuan (anti-lompat untuk 29 Feb & 31 Jan).
  const anniversaryDay = Math.min(hd, daysInMonth(ry, rm));
  return rd < anniversaryDay ? Math.max(0, months - 1) : Math.max(0, months);
};

export interface ThrInput {
  baseSalary: number;                   // gaji pokok/upah bulanan terakhir (Rp)
  hireDate: string | null | undefined;  // tanggal masuk kerja 'YYYY-MM-DD'
  refDate: string;                      // tanggal acuan hitung 'YYYY-MM-DD'
  config?: Partial<ThrConfig>;          // opsional: override kebijakan (BR-24)
}

export interface ThrResult {
  eligible: boolean;         // berhak THR?
  monthsWorked: number;      // masa kerja bulan penuh s/d refDate
  prorataFactor: number;     // 0..1 — min(masa, monthsForFull) ÷ monthsForFull
  full: boolean;             // masa kerja ≥ monthsForFull → THR penuh
  amount: number;            // THR rupiah (dibulatkan)
  reason: string | null;     // alasan tidak berhak (null bila berhak)
}

const roundRp = (n: number): number => Math.round(n);

/** Hitung THR satu karyawan (BR-13). Tanpa I/O; refDate dari pemanggil
 *  (tanggal run) supaya deterministik untuk unit test. */
export const computeThr = (input: ThrInput): ThrResult => {
  const cfg: ThrConfig = { ...DEFAULT_THR_CONFIG };
  const patch = input.config;
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    const o = patch as Record<string, unknown>;
    if (typeof o.monthsForFull === 'number' && Number.isFinite(o.monthsForFull) && o.monthsForFull >= 1 && o.monthsForFull <= 60) {
      cfg.monthsForFull = Math.round(o.monthsForFull);
    }
    if (typeof o.multiplier === 'number' && Number.isFinite(o.multiplier) && o.multiplier >= 0 && o.multiplier <= 12) {
      cfg.multiplier = o.multiplier;
    }
    if (typeof o.minMonths === 'number' && Number.isFinite(o.minMonths) && o.minMonths >= 0 && o.minMonths <= 60) {
      cfg.minMonths = Math.round(o.minMonths);
    }
  }

  const base = Math.max(0, Math.round(input.baseSalary || 0));
  const hire = typeof input.hireDate === 'string' && dateRe.test(input.hireDate) ? input.hireDate : null;
  const ref = typeof input.refDate === 'string' && dateRe.test(input.refDate) ? input.refDate : '';

  const deny = (months: number, reason: string): ThrResult => ({
    eligible: false, monthsWorked: months, prorataFactor: 0, full: false, amount: 0, reason,
  });

  if (!ref) return deny(0, 'Tanggal acuan hitung tidak valid.');
  if (!hire) return deny(0, 'Tanggal masuk kerja belum diisi.');

  const months = tenureMonths(hire, ref);
  if (base <= 0) return deny(months, 'Gaji pokok belum diisi.');
  const factor = Math.min(months, cfg.monthsForFull) / cfg.monthsForFull;
  if (months < cfg.minMonths) {
    return deny(months, `Masa kerja ${months} bulan — di bawah minimum ${cfg.minMonths} bulan.`);
  }
  return {
    eligible: true,
    monthsWorked: months,
    prorataFactor: factor,
    full: months >= cfg.monthsForFull,
    amount: roundRp(base * cfg.multiplier * factor),
    reason: null,
  };
};

// ── Konfigurasi per org (JSON di app_config `thr:<orgId>`) ──────────
// Clone pola parseBpjsConfig/mergeBpjsConfig: nilai liar diabaikan.

const RANGE: Record<keyof ThrConfig, { min: number; max: number; int?: boolean }> = {
  monthsForFull: { min: 1, max: 60, int: true },
  multiplier: { min: 0, max: 12 },
  minMonths: { min: 0, max: 60, int: true },
};

const validValue = (key: keyof ThrConfig, v: unknown): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const r = RANGE[key];
  if (v < r.min || v > r.max) return null;
  return r.int ? Math.round(v) : v;
};

/** Parse konfigurasi THR org dengan merge atas default — JSON rusak /
 *  field tak dikenal / nilai di luar rentang diabaikan. */
export const parseThrConfig = (raw: string | null | undefined): ThrConfig => {
  if (!raw) return { ...DEFAULT_THR_CONFIG };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ...DEFAULT_THR_CONFIG }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_THR_CONFIG };
  const obj = parsed as Record<string, unknown>;
  const out: ThrConfig = { ...DEFAULT_THR_CONFIG };
  for (const key of Object.keys(RANGE) as (keyof ThrConfig)[]) {
    const v = validValue(key, obj[key]);
    if (v !== null) out[key] = v;
  }
  return out;
};

/** Merge patch admin (sebagian field) ke konfigurasi saat ini, lalu validasi.
 *  Nilai patch di luar rentang wajar → field tetap memakai nilai `current`. */
export const mergeThrConfig = (current: ThrConfig, patch: unknown): ThrConfig => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ...current };
  const obj = patch as Record<string, unknown>;
  const clean: Record<string, number> = {};
  for (const key of Object.keys(RANGE) as (keyof ThrConfig)[]) {
    const v = validValue(key, obj[key]);
    if (v !== null) clean[key] = v;
  }
  return parseThrConfig(JSON.stringify({ ...current, ...clean }));
};
