// ─────────────────────────────────────────────────────────────
// Presensia — Payroll domain engine (unit test murni).
// Model: net = (gaji − potongan hadir + lembur) − PPh 21 − iuran BPJS karyawan.
// ─────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import {
  computePayroll, hourlyRate, roundRp, HOURLY_FACTOR,
  DEFAULT_BPJS_CONFIG, computeBpjs, computePph21Ter,
} from '../src/domain/payroll/engine';

const base = {
  baseSalary: 5_000_000, workingDays: 21, presentDays: 21, absentDays: 0,
  lateMinutes: 0, overtimeMinutes: 0, overtimeMultiplier: 1.5,
};

describe('payroll engine — komponen dasar', () => {
  it('tanpa absen/lembur: gross = gaji, PPh 21 = 0 (di bawah 5,4 jt), net = gaji − iuran karyawan', () => {
    const r = computePayroll(base);
    expect(r.grossMonthly).toBe(5_000_000);
    expect(r.absenceDeduction).toBe(0);
    expect(r.overtimePay).toBe(0);
    expect(r.pph21.tax).toBe(0);            // 5 jt ≤ 5,4 jt (TER A 0%)
    expect(r.bpjsEmployeeTotal).toBe(203_000); // JHT 100k + JP 50k + JKP 3k + Kes 50k
    expect(r.netPay).toBe(5_000_000 - 203_000);
  });

  it('potongan absen = dailyRate × hari absent dan masuk bruto', () => {
    const r = computePayroll({ ...base, absentDays: 2 });
    const expectedDeduction = Math.round((5_000_000 / 21) * 2);
    expect(r.absenceDeduction).toBe(expectedDeduction);
    expect(r.grossMonthly).toBe(5_000_000 - expectedDeduction);
    expect(r.netPay).toBe(r.grossMonthly - r.pph21.tax - r.bpjsEmployeeTotal);
  });

  it('lembur masuk bruto (kena TER) tapi tidak masuk dasar BPJS', () => {
    const r = computePayroll({ ...base, overtimeMinutes: 120 });
    const expectedOt = Math.round((120 / 60) * Math.round(5_000_000 / HOURLY_FACTOR) * 1.5);
    expect(r.overtimePay).toBe(expectedOt);
    // Dasar BPJS tetap dari gaji pokok saja.
    expect(r.bpjs.wageBase).toBe(5_000_000);
    expect(r.bpjs.employee.jht).toBe(100_000);
    // Bruto = 5 jt + OT → masuk lapisan TER 0,5% (5.65–5.95 jt)? tergantung OT.
    expect(r.pph21.tax).toBe(Math.round(r.grossMonthly * r.pph21.rate));
    expect(r.grossMonthly).toBe(5_000_000 + expectedOt);
  });

  it('net tidak pernah minus (potongan dibatasi gaji pokok)', () => {
    const r = computePayroll({ ...base, absentDays: 40 });
    expect(r.absenceDeduction).toBe(5_000_000);
    expect(r.grossMonthly).toBe(0);
    expect(r.netPay).toBe(0);
  });

  it('gaji 0 → semua komponen 0 tanpa error', () => {
    const r = computePayroll({ ...base, baseSalary: 0 });
    expect(r.netPay).toBe(0);
    expect(r.overtimePay).toBe(0);
    expect(r.bpjsEmployeeTotal).toBe(0);
  });

  it('roundRp dan hourlyRate konsisten', () => {
    expect(roundRp(1234.56)).toBe(1235);
    expect(hourlyRate(3_460_000)).toBe(20_000);
  });
});

describe('payroll engine — PTKP & JP cap', () => {
  it('K/1 (TER B): ambang nol lebih tinggi (6,2 jt)', () => {
    const r = computePayroll({ ...base, baseSalary: 6_000_000, ptkp: 'K/1' });
    expect(r.pph21.tax).toBe(0);  // 6 jt ≤ 6,2 jt TER B → 0%
  });

  it('K/0 dengan gaji 7 jt → TER 1,25% (contoh resmi DJP)', () => {
    const r = computePayroll({ ...base, baseSalary: 7_000_000, ptkp: 'K/0' });
    expect(r.pph21.category).toBe('A');
    expect(r.pph21.rate).toBe(0.0125);
    // bruto = 7 jt, pengurang = iuran karyawan JHT(140k)+JP(70k) = 210k → 6.790.000 → masih lapis 1,25% (≤7,5 jt)
    expect(r.pph21.tax).toBe(Math.round(6_790_000 * 0.0125));
  });

  it('gaji tinggi: JP di-cap 10.547.400', () => {
    const r = computePayroll({ ...base, baseSalary: 20_000_000 });
    expect(r.bpjs.wageBaseJp).toBe(DEFAULT_BPJS_CONFIG.jpWageCap);
    expect(r.bpjs.employee.jp).toBe(Math.round(DEFAULT_BPJS_CONFIG.jpWageCap * 0.01));
    expect(r.bpjs.employee.jht).toBe(400_000); // tanpa cap
  });

  it('JKK kelas risiko dihormati (kelas V = 1,74%)', () => {
    const r = computePayroll({ ...base, baseSalary: 10_000_000, jkkRiskClassRate: 0.0174 });
    expect(r.bpjs.company.jkk).toBe(174_000);
  });

  it('bruto minus (potongan > gaji, tanpa lembur) → pajak 0 & net 0', () => {
    const r = computePayroll({ ...base, absentDays: 30 });
    expect(r.pph21.tax).toBe(0);
    expect(r.netPay).toBe(0);
  });
});

describe('integritas silang modul re-eksport', () => {
  it('computeBpjs/computePph21Ter identik dengan domain masing-masing', () => {
    const bpjs = computeBpjs(4_000_000);
    expect(bpjs.company.jht).toBe(148_000);
    const tax = computePph21Ter(7_000_000, 'K/0');
    expect(tax.tax).toBe(87_500);
  });
});
