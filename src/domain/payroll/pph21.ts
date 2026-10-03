// ─────────────────────────────────────────────────────────────
// Presensia — PPh 21 TER calculator (murni, tanpa I/O).
//
// Sumber angka: PP 58/2023 & PMK 168/2023 (tarif efektif rata-rata bulanan,
// berlaku Januari 2024 untuk masa pajak Jan–Nov; Desember memakai tarif
// Pasal 17 — di luar cakupan engine ini).
//
//   TER A: PTKP TK/0 (54 jt) serta TK/1 & K/0 (58,5 jt)
//   TER B: PTKP TK/2 & K/1 (63 jt) serta TK/3 & K/2 (67,5 jt)
//   TER C: PTKP K/3 (72 jt)
//
// PPh 21 bulanan = TER × penghasilan bruto bulanan.
// Bruto = gaji pokok + tunjangan + lembur (− iuran pensiun/JHT karyawan).
// Lihat test/pph21-ter.test.ts untuk contoh resmi yang dites.
// ─────────────────────────────────────────────────────────────

export type TerCategory = 'A' | 'B' | 'C';

export type PtkpStatus =
  | 'TK/0' | 'TK/1' | 'TK/2' | 'TK/3'
  | 'K/0' | 'K/1' | 'K/2' | 'K/3';

/** Batas atas bruto (inklusif) per lapisan TER — rupiah, dari lampiran PP 58/2023. */
type Band = [upperBound: number, rate: number];

export const TER_A: readonly Band[] = [
  [5_400_000, 0], [5_650_000, 0.0025], [5_950_000, 0.005], [6_300_000, 0.0075],
  [6_750_000, 0.01], [7_500_000, 0.0125], [8_550_000, 0.015], [9_650_000, 0.0175],
  [10_050_000, 0.02], [10_350_000, 0.0225], [10_700_000, 0.025], [11_050_000, 0.03],
  [11_600_000, 0.035], [12_500_000, 0.04], [13_750_000, 0.05], [15_100_000, 0.06],
  [16_950_000, 0.07], [19_750_000, 0.08], [24_150_000, 0.09], [26_450_000, 0.1],
  [28_000_000, 0.11], [30_050_000, 0.12], [32_400_000, 0.13], [35_400_000, 0.14],
  [39_100_000, 0.15], [43_850_000, 0.16], [47_800_000, 0.17], [51_400_000, 0.18],
  [56_300_000, 0.19], [62_200_000, 0.2], [68_600_000, 0.21], [77_500_000, 0.22],
  [89_000_000, 0.23], [103_000_000, 0.24], [125_000_000, 0.25], [157_000_000, 0.26],
  [206_000_000, 0.27], [337_000_000, 0.28], [454_000_000, 0.29], [550_000_000, 0.3],
  [695_000_000, 0.31], [910_000_000, 0.32], [1_400_000_000, 0.33],
  [Number.MAX_SAFE_INTEGER, 0.34],
] as const;

export const TER_B: readonly Band[] = [
  [6_200_000, 0], [6_500_000, 0.0025], [6_850_000, 0.005], [7_300_000, 0.0075],
  [9_200_000, 0.01], [10_750_000, 0.015], [11_250_000, 0.02], [11_600_000, 0.025],
  [12_600_000, 0.03], [13_600_000, 0.04], [14_950_000, 0.05], [16_400_000, 0.06],
  [18_450_000, 0.07], [21_850_000, 0.08], [26_000_000, 0.09], [27_700_000, 0.1],
  [29_350_000, 0.11], [31_450_000, 0.12], [33_950_000, 0.13], [37_100_000, 0.14],
  [41_100_000, 0.15], [45_800_000, 0.16], [49_500_000, 0.17], [53_800_000, 0.18],
  [58_500_000, 0.19], [64_000_000, 0.2], [71_000_000, 0.21], [80_000_000, 0.22],
  [93_000_000, 0.23], [109_000_000, 0.24], [129_000_000, 0.25], [163_000_000, 0.26],
  [211_000_000, 0.27], [374_000_000, 0.28], [459_000_000, 0.29], [555_000_000, 0.3],
  [704_000_000, 0.31], [957_000_000, 0.32], [1_405_000_000, 0.33],
  [Number.MAX_SAFE_INTEGER, 0.34],
] as const;

export const TER_C: readonly Band[] = [
  [6_600_000, 0], [6_950_000, 0.0025], [7_350_000, 0.005], [7_800_000, 0.0075],
  [8_850_000, 0.01], [9_800_000, 0.0125], [10_950_000, 0.015], [11_200_000, 0.0175],
  [12_050_000, 0.02], [12_950_000, 0.03], [14_150_000, 0.04], [15_550_000, 0.05],
  [17_050_000, 0.06], [19_500_000, 0.07], [22_700_000, 0.08], [26_600_000, 0.09],
  [28_100_000, 0.1], [30_100_000, 0.11], [32_600_000, 0.12], [35_400_000, 0.13],
  [38_900_000, 0.14], [43_000_000, 0.15], [47_400_000, 0.16], [51_200_000, 0.17],
  [55_800_000, 0.18], [60_400_000, 0.19], [66_700_000, 0.2], [74_500_000, 0.21],
  [83_200_000, 0.22], [95_600_000, 0.23], [110_000_000, 0.24], [134_000_000, 0.25],
  [169_000_000, 0.26], [221_000_000, 0.27], [390_000_000, 0.28], [463_000_000, 0.29],
  [561_000_000, 0.3], [709_000_000, 0.31], [965_000_000, 0.32], [1_419_000_000, 0.33],
  [Number.MAX_SAFE_INTEGER, 0.34],
] as const;

const TABLES: Record<TerCategory, readonly Band[]> = { A: TER_A, B: TER_B, C: TER_C };

/** Kategori TER dari status PTKP (PMK 168/2023). */
export const terCategory = (ptkp: PtkpStatus): TerCategory => {
  switch (ptkp) {
    case 'TK/0': case 'TK/1': case 'K/0': return 'A';
    case 'TK/2': case 'K/1': case 'TK/3': case 'K/2': return 'B';
    case 'K/3': return 'C';
  }
};

/** Tarif efektif bulanan untuk bruto tertentu (mis. 7.000.000 K/0 → 1,25%). */
export const terRate = (grossMonthly: number, ptkp: PtkpStatus): number => {
  const bands = TABLES[terCategory(ptkp)];
  const g = Math.max(0, Math.round(grossMonthly));
  for (const [upper, rate] of bands) {
    if (g <= upper) return rate;
  }
  return bands[bands.length - 1]![1];
};

export interface Pph21Result {
  category: TerCategory;
  rate: number;             // tarif efektif (mis. 0.0125)
  grossMonthly: number;     // bruto dasar hitung
  tax: number;              // PPh 21 dipotong (rupiah, ≥ 0)
}

/** PPh 21 bulanan (TER) = rate × bruto. Bruto = gaji + tunjangan + lembur
 *  − iuran JHT/JP karyawan (pengurang bruto sesuai ketentuan). */
export const computePph21Ter = (
  grossMonthly: number,
  ptkp: PtkpStatus = 'TK/0',
  deductions = 0,           // iuran JHT+JP karyawan dll.
): Pph21Result => {
  const base = Math.max(0, Math.round(grossMonthly) - Math.max(0, Math.round(deductions)));
  const category = terCategory(ptkp);
  const rate = terRate(base, ptkp);
  return { category, rate, grossMonthly: base, tax: Math.round(base * rate) };
};

// ─────────────────────────────────────────────────────────────
// MASA PAJAK TERAKHIR (Desember) — Pasal 17(1)a UU PPh jo. UU HPP 7/2021.
// Berlaku untuk Desember ATAU pegawai tetap berhenti di tengah tahun
// (bagian tahun pajak). Sumber: PMK 168/2023 — langkah resmi:
//   1. Hitung bruto setahun (semua masa dalam tahun pajak).
//   2. Kurangi pengurang setahun: biaya jabatan (5%/bln, maks 500rb/bln →
//      maks 6jt/tahun), iuran pensiun yang dibayar pegawai (JHT/JP karyawan),
//      dan zakat yang dibayarkan melalui pemberi kerja.
//   3. Kurangi PTKP (setahun penuh) → penghasilan kena pajak (PKP).
//   4. PPh 21 terutang setahun = tarif Pasal 17 progresif × PKP.
//   5. PPh 21 Desember = terutang setahun − PPh 21 sudah dipotong Jan–Nov.
//      Bila negatif → kelebihan potong (refund via 1721-A1), dipotong 0.
// Angka PTKP/tarif adalah konfigurasi regulasi (BR-24) — verifikasi ulang
// sebelum dipakai payroll nyata.
// ─────────────────────────────────────────────────────────────

/** PTKP tahunan per status (UU PPh jo. UU HPP — rupiah). */
export const PTKP_ANNUAL: Record<PtkpStatus, number> = {
  'TK/0': 54_000_000,
  'TK/1': 58_500_000,
  'TK/2': 63_000_000,
  'TK/3': 67_500_000,
  'K/0': 58_500_000,
  'K/1': 63_000_000,
  'K/2': 67_500_000,
  'K/3': 72_000_000,
};

/** Lapisan Pasal 17(1)a: [batas atas PKP, tarif] — progresif per lapisan. */
export const PASAL_17_BANDS: readonly [upper: number, rate: number][] = [
  [60_000_000, 0.05],
  [250_000_000, 0.15],
  [500_000_000, 0.25],
  [5_000_000_000, 0.3],
  [Number.MAX_SAFE_INTEGER, 0.35],
] as const;

/** PPh 21 terutang setahun = tarif Pasal 17 progresif × PKP (≥ 0). */
export const computePasal17 = (pkp: number): number => {
  let remaining = Math.max(0, Math.round(pkp));
  let lower = 0;
  let tax = 0;
  for (const [upper, rate] of PASAL_17_BANDS) {
    const width = upper - lower;
    const inBand = Math.min(remaining, width);
    tax += Math.round(inBand * rate);
    remaining -= inBand;
    lower = upper;
    if (remaining <= 0) break;
  }
  return tax;
};

/** Biaya jabatan setahun = Σ min(500rb, 5% × bruto bulan itu) (maks 6jt). */
export const biayaJabatanSetahun = (monthlyGross: readonly number[]): number => {
  let total = 0;
  for (const g of monthlyGross) total += Math.min(500_000, Math.round(Math.max(0, g) * 0.05));
  return total;
};

export interface YearEndInput {
  monthlyGross: readonly number[];          // bruto tiap bulan tercatat dalam tahun pajak (Jan–Des / bagian tahun)
  monthlyEmployeePension: readonly number[]; // iuran pensiun karyawan per bulan (JHT + JP karyawan)
  ptkp: PtkpStatus;
  zakat?: number;                           // zakat via pemberi kerja (setahun)
  withheldJanNov: number;                   // total PPh 21 sudah dipotong masa sebelumnya
}

export interface YearEndResult {
  annualGross: number;
  biayaJabatan: number;
  iuranPensiun: number;
  zakat: number;
  ptkp: number;
  pkp: number;              // penghasilan kena pajak tahunan (≥ 0)
  annualTax: number;        // PPh 21 terutang setahun (Pasal 17)
  withheldJanNov: number;   // kredit masa sebelumnya
  dueDecember: number;      // PPh 21 yang dipotong di masa terakhir (≥ 0)
  overWithheld: number;     // kelebihan potong (refund 1721-A1, ≥ 0)
  effectiveRate: number;    // dueDecember / annualGross (tampilan slip)
}

/** Penyesuaian akhir tahun (Masa Pajak Terakhir, Pasal 17). */
export const computeYearEndPph21 = (input: YearEndInput): YearEndResult => {
  const annualGross = Math.max(0, Math.round(input.monthlyGross.reduce((a, g) => a + Math.max(0, Math.round(g)), 0)));
  const biayaJabatan = biayaJabatanSetahun(input.monthlyGross);
  const iuranPensiun = Math.max(0, Math.round(input.monthlyEmployeePension.reduce((a, p) => a + Math.max(0, Math.round(p)), 0)));
  const zakat = Math.max(0, Math.round(input.zakat ?? 0));
  const ptkp = PTKP_ANNUAL[input.ptkp];
  const pkp = Math.max(0, annualGross - biayaJabatan - iuranPensiun - zakat - ptkp);
  const annualTax = computePasal17(pkp);
  const withheld = Math.max(0, Math.round(input.withheldJanNov));
  const selisih = annualTax - withheld;
  const dueDecember = Math.max(0, selisih);
  const overWithheld = Math.max(0, -selisih);
  return {
    annualGross, biayaJabatan, iuranPensiun, zakat, ptkp, pkp, annualTax,
    withheldJanNov: withheld, dueDecember, overWithheld,
    effectiveRate: annualGross > 0 ? dueDecember / annualGross : 0,
  };
};
