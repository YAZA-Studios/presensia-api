// ─────────────────────────────────────────────────────────────
// Presensia — Payroll engine (murni, tanpa I/O, tanpa impor di luar domain).
// Input: baris timesheet ringkas (struktural — cocok dengan TimesheetRow),
// jumlah hari kerja, lembur disetujui, gaji pokok → komponen slip gaji.
//
// Model hitung (bulanan, didistribusikan per hari kerja):
//   dailyRate        = baseSalary / workingDays
//   absenceDeduction = dailyRate × hari tidak hadir (absent)
//   overtimePay      = menit lembur disetujui ÷ 60 × hourlyRate × multiplier
//   bpjs             = iuran karyawan (JHT, JP, JKP, Kesehatan) — dipotong take-home
//   pph21            = TER × bruto; bruto = gaji − potongan hadir + lembur
//                      − iuran JHT + JP karyawan (pengurang sesuai ketentuan)
//   netPay           = bruto − PPh 21 − iuran karyawan (dibulatkan ke rupiah)
//
// Prinsip BR-10: net dibatasi ≥ 0; potongan hadir dibatasi maksimum gaji pokok.
// ─────────────────────────────────────────────────────────────
import { computeBpjs, DEFAULT_BPJS_CONFIG } from './bpjs';
import { computePph21Ter } from './pph21';
import type { BpjsConfig, BpjsResult } from './bpjs';
import type { Pph21Result, PtkpStatus } from './pph21';

export { computeBpjs, DEFAULT_BPJS_CONFIG } from './bpjs';
export { computePph21Ter, terCategory, terRate, TER_A, TER_B, TER_C, computePasal17, computeYearEndPph21, biayaJabatanSetahun, PTKP_ANNUAL, PASAL_17_BANDS } from './pph21';
export type { BpjsConfig, BpjsResult } from './bpjs';
export type { Pph21Result, PtkpStatus, TerCategory, YearEndInput, YearEndResult } from './pph21';
export { computeThr, tenureMonths, DEFAULT_THR_CONFIG, parseThrConfig, mergeThrConfig } from './thr';
export type { ThrConfig, ThrInput, ThrResult } from './thr';

/** Baris timesheet minimal yang dipakai engine (struktural, tanpa impor). */
export interface TimesheetLike {
  status: string;
  lateMinutes: number;
}

export interface PayrollInput {
  baseSalary: number;              // rupiah/bulan
  workingDays: number;             // hari kerja dalam bulan tsb (> 0)
  presentDays: number;             // hari hadir (present + late)
  absentDays: number;              // hari berstatus 'absent'
  lateMinutes: number;             // total menit telat
  overtimeMinutes: number;         // menit lembur disetujui
  overtimeMultiplier: number;      // 1.5 hari kerja / 2 hari libur
  ptkp?: PtkpStatus;               // status PTKP (default TK/0)
  jkkRiskClassRate?: number;       // opsional: tarif JKK perusahaan (mis. 0.0174)
  bpjsConfig?: Partial<BpjsConfig>; // opsional: override tarif/plafon (BR-24)
}

export interface PayrollResult {
  baseSalary: number;
  presentDays: number;
  lateMinutes: number;
  overtimeMinutes: number;
  overtimePay: number;
  absenceDeduction: number;
  grossMonthly: number;            // bruto untuk PPh 21 (setelah pengurang)
  bpjs: BpjsResult;                // rincian iuran perusahaan + karyawan
  bpjsEmployeeTotal: number;       // potongan dari take-home
  pph21: Pph21Result;              // rincian TER (kategori, tarif, pajak)
  netPay: number;                  // take-home setelah pajak & iuran karyawan
}

/** Bulatkan ke rupiah terdekat (angka uang tidak boleh pecahan). */
export const roundRp = (n: number): number => Math.round(n);

/** Gaji per jam: asumsi 173 jam/bulan (kebiasaan upah Indonesia, Kepnakertrans). */
export const HOURLY_FACTOR = 173;

export const hourlyRate = (baseSalary: number): number =>
  baseSalary > 0 ? roundRp(baseSalary / HOURLY_FACTOR) : 0;

export const computePayroll = (input: PayrollInput): PayrollResult => {
  const base = Math.max(0, Math.round(input.baseSalary));
  const workingDays = Math.max(1, Math.round(input.workingDays));
  const absent = Math.max(0, Math.round(input.absentDays));
  const daily = base / workingDays;
  const absenceDeduction = roundRp(Math.min(base, daily * absent));
  const overtimePay = roundRp(
    (Math.max(0, input.overtimeMinutes) / 60) * hourlyRate(base) * Math.max(0, input.overtimeMultiplier),
  );

  // ── BPJS: dasar = gaji pokok (upah tetap), bukan termasuk lembur ──
  const bpjsCfg: BpjsConfig = { ...DEFAULT_BPJS_CONFIG, ...(input.bpjsConfig ?? {}) };
  if (input.jkkRiskClassRate !== undefined) bpjsCfg.jkkCompany = input.jkkRiskClassRate;
  const bpjs = computeBpjs(base, bpjsCfg);
  const bpjsEmployeeTotal = bpjs.employee.total;

  // ── PPh 21 TER: bruto = gaji − potongan hadir + lembur − iuran JHT/JP karyawan ──
  const gross = Math.max(0, base - absenceDeduction + overtimePay);
  const pph21 = computePph21Ter(
    gross,
    input.ptkp ?? 'TK/0',
    bpjs.employee.jht + bpjs.employee.jp,
  );

  const netPay = Math.max(0, gross - pph21.tax - bpjsEmployeeTotal);
  return {
    baseSalary: base,
    presentDays: Math.max(0, Math.round(input.presentDays)),
    lateMinutes: Math.max(0, Math.round(input.lateMinutes)),
    overtimeMinutes: Math.max(0, Math.round(input.overtimeMinutes)),
    overtimePay,
    absenceDeduction,
    grossMonthly: gross,
    bpjs,
    bpjsEmployeeTotal,
    pph21,
    netPay,
  };
};

/** Ringkas baris timesheet per karyawan untuk payroll.
 *  status dihitung dari kolom status (present/late/leave/sick/absent). */
export const summarizeEmployee = (rows: TimesheetLike[], approvedOvertimeMinutes: number, workingDays: number): PayrollInput => {
  const present = rows.filter((r) => r.status === 'present' || r.status === 'late').length;
  const absent = rows.filter((r) => r.status === 'absent').length;
  const lateMinutes = rows.reduce((acc, r) => acc + (r.lateMinutes || 0), 0);
  return {
    baseSalary: 0, // diisi caller dari profil gaji
    workingDays,
    absentDays: absent,
    presentDays: present,
    lateMinutes,
    overtimeMinutes: Math.max(0, approvedOvertimeMinutes),
    overtimeMultiplier: 1.5,
  };
};
