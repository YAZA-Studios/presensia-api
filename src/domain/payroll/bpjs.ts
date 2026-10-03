// ─────────────────────────────────────────────────────────────
// Presensia — BPJS calculator (murni, tanpa I/O).
//
// Komponen & tarif (kebiasaan per 2024/2025):
//   BPJS Ketenagakerjaan:
//     • JHT  — Perusahaan 3,7%  | Karyawan 2%   (tanpa batas upah)
//     • JKK  — Perusahaan 0,24%–1,74% sesuai kelas risiko:
//              I=0,24 II=0,38 III=0,74 IV=1,27 V=1,74 (default I)
//     • JKM  — Perusahaan 0,3%  (tanpa batas upah)
//     • JP   — Perusahaan 2%    | Karyawan 1%   (batas upah 10.547.400)
//     • JKP  — Perusahaan 0,24% | Karyawan 0,06%
//              (porsi pemerintah 0,16% di luar payroll — PMK 78/2022)
//   BPJS Kesehatan: Perusahaan 4% | Karyawan 1% (batas upah 12.000.000)
//
// Semua angka KONFIGURASI, bukan hard-code keputusan: regulasi iuran/PLAFON
// berubah (umumnya tiap awal tahun) — perbarui nilai config, bukan kode
// (prinsip BR-24: tabel aturan berversi). Verifikasi ke BPJS resmi sebelum
// digunakan untuk payroll nyata.
// ─────────────────────────────────────────────────────────────

export interface BpjsConfig {
  jhtCompany: number;          // 0.037
  jhtEmployee: number;         // 0.02
  jkkCompany: number;          // 0.0024 (kelas risiko I; maks 0.0174)
  jkmCompany: number;          // 0.003
  jpCompany: number;           // 0.02
  jpEmployee: number;          // 0.01
  jpWageCap: number;           // 10_547_400 — perbarui tiap tahun
  jkpCompany: number;          // 0.0024
  jkpEmployee: number;         // 0.0006
  kesehatanCompany: number;    // 0.04
  kesehatanEmployee: number;   // 0.01
  kesehatanWageCap: number;    // 12_000_000
}

export const DEFAULT_BPJS_CONFIG: BpjsConfig = {
  jhtCompany: 0.037,
  jhtEmployee: 0.02,
  jkkCompany: 0.0024,
  jkmCompany: 0.003,
  jpCompany: 0.02,
  jpEmployee: 0.01,
  jpWageCap: 10_547_400,
  jkpCompany: 0.0024,
  jkpEmployee: 0.0006,
  kesehatanCompany: 0.04,
  kesehatanEmployee: 0.01,
  kesehatanWageCap: 12_000_000,
};

/** Kelas risiko JKK (bpjs ketenagakerjaan) — dipilih admin, tanpa deploy. */
export interface JkkRiskClass {
  id: string;        // 'I' | 'II' | ... | 'V'
  label: string;
  rate: number;      // fraksi (0.0024 = 0,24%)
}

export const JKK_RISK_CLASSES: readonly JkkRiskClass[] = [
  { id: 'I', label: 'Kelas I — perkantoran/kegiatan ringan', rate: 0.0024 },
  { id: 'II', label: 'Kelas II — konstruksi ringan/pertanian', rate: 0.0038 },
  { id: 'III', label: 'Kelas III — pengolahan ringan/perdagangan', rate: 0.0074 },
  { id: 'IV', label: 'Kelas IV — transportasi/listrik', rate: 0.0127 },
  { id: 'V', label: 'Kelas V — pertambangan/konstruksi berat', rate: 0.0174 },
];

const RATE_KEYS = [
  'jhtCompany', 'jhtEmployee', 'jkkCompany', 'jkmCompany',
  'jpCompany', 'jpEmployee', 'jkpCompany', 'jkpEmployee',
  'kesehatanCompany', 'kesehatanEmployee',
] as const;
const CAP_KEYS = ['jpWageCap', 'kesehatanWageCap'] as const;

/** Parse konfigurasi BPJS org (JSON di app_config `bpjs:<orgId>`) dengan
 *  merge + clamp atas default — field tak dikenal/nilai liar diabaikan
 *  (kebijakan BR-24: aturan bisa berubah lewat konfigurasi, bukan kode). */
export const parseBpjsConfig = (raw: string | null | undefined): BpjsConfig => {
  if (!raw) return { ...DEFAULT_BPJS_CONFIG };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ...DEFAULT_BPJS_CONFIG }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_BPJS_CONFIG };
  const obj = parsed as Record<string, unknown>;
  const out: BpjsConfig = { ...DEFAULT_BPJS_CONFIG };
  for (const key of RATE_KEYS) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) out[key] = v;
  }
  for (const key of CAP_KEYS) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000_000) out[key] = Math.round(v);
  }
  return out;
};

/** Merge patch admin (sebagian field) ke konfigurasi saat ini, lalu validasi.
 *  Nilai patch di luar rentang wajar → field tetap memakai nilai `current`. */
export const mergeBpjsConfig = (current: BpjsConfig, patch: unknown): BpjsConfig => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ...current };
  const obj = patch as Record<string, unknown>;
  const clean: Record<string, number> = {};
  for (const key of RATE_KEYS) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1) clean[key] = v;
  }
  for (const key of CAP_KEYS) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000_000) clean[key] = Math.round(v);
  }
  return parseBpjsConfig(JSON.stringify({ ...current, ...clean }));
};

export interface BpjsResult {
  /** Dasar pengenaan iuran BPJS Ketenagakerjaan (gaji kontrak bulanan). */
  wageBase: number;
  /** Dasar pengenaan JP (setelah batas upah JP). */
  wageBaseJp: number;
  /** Dasar pengenaan BPJS Kesehatan (setelah batas upah). */
  wageBaseKesehatan: number;
  employee: {
    jht: number; jp: number; jkp: number; kesehatan: number; total: number;
  };
  company: {
    jht: number; jkk: number; jkm: number; jp: number; jkp: number; kesehatan: number; total: number;
  };
}

const roundRp = (n: number): number => Math.round(n);
const portion = (base: number, rate: number): number => roundRp(Math.max(0, base) * Math.max(0, rate));

/** Hitung iuran BPJS perusahaan + karyawan dari gaji bulanan (sebelum lembur).
 *  Lembur TIDAK diikutkan ke dasar iuran BPJS (kebiasaan umum: iuran dihitung
 *  dari upah pokok/tetap), sedangkan PPh 21 TER dihitung dari bruto termasuk lembur. */
export const computeBpjs = (monthlyWage: number, config: BpjsConfig = DEFAULT_BPJS_CONFIG): BpjsResult => {
  const wage = Math.max(0, Math.round(monthlyWage));
  const wageBaseJp = Math.min(wage, config.jpWageCap);
  const wageBaseKesehatan = Math.min(wage, config.kesehatanWageCap);

  const employee = {
    jht: portion(wage, config.jhtEmployee),
    jp: portion(wageBaseJp, config.jpEmployee),
    jkp: portion(wage, config.jkpEmployee),
    kesehatan: portion(wageBaseKesehatan, config.kesehatanEmployee),
    total: 0,
  };
  employee.total = employee.jht + employee.jp + employee.jkp + employee.kesehatan;

  const company = {
    jht: portion(wage, config.jhtCompany),
    jkk: portion(wage, config.jkkCompany),
    jkm: portion(wage, config.jkmCompany),
    jp: portion(wageBaseJp, config.jpCompany),
    jkp: portion(wage, config.jkpCompany),
    kesehatan: portion(wageBaseKesehatan, config.kesehatanCompany),
    total: 0,
  };
  company.total = company.jht + company.jkk + company.jkm + company.jp + company.jkp + company.kesehatan;

  return { wageBase: wage, wageBaseJp, wageBaseKesehatan, employee, company };
};
