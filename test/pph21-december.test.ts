// ─────────────────────────────────────────────────────────────
// Presensia — PPh 21 Masa Pajak Terakhir (Pasal 17) unit test.
// Kasus Ryan mengikuti contoh resmi ortax/PMK 168/2023:
//   K/2, bruto Jan–Mei 17,5jt/bln, Jun–Des 15jt/bln, iuran pensiun 200rb/bln.
//   Bruto setahun 192,5jt − biaya jabatan 6jt − iuran 2,4jt − PTKP K/2 67,5jt
//   = PKP 116,6jt → Pasal 17 = 5%×60jt + 15%×56,6jt = 11.490.000
//   Terutang 11.490.000 − Jan–Nov 11.025.000 = Desember 465.000
// ─────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import {
  computePasal17, computeYearEndPph21, biayaJabatanSetahun,
  PTKP_ANNUAL, PASAL_17_BANDS,
} from '../src/domain/payroll/pph21';

describe('computePasal17 — tarif progresif Pasal 17(1)a UU HPP', () => {
  it('PKP 0 → 0', () => {
    expect(computePasal17(0)).toBe(0);
    expect(computePasal17(-5_000_000)).toBe(0);
  });

  it('batas lapis pertama: PKP 60jt → 5% = 3.000.000', () => {
    expect(computePasal17(60_000_000)).toBe(3_000_000);
  });

  it('lapis kedua: PKP 250jt → 3jt + 15%×190jt = 31.500.000', () => {
    expect(computePasal17(250_000_000)).toBe(3_000_000 + 28_500_000);
  });

  it('lapis ketiga: PKP 500jt → +25%×250jt = 94.000.000', () => {
    expect(computePasal17(500_000_000)).toBe(3_000_000 + 28_500_000 + 62_500_000);
  });

  it('lapis keempat: PKP 5M → +30%×4,5M', () => {
    expect(computePasal17(5_000_000_000)).toBe(3_000_000 + 28_500_000 + 62_500_000 + 1_350_000_000);
  });

  it('di atas 5M → lapis 35%', () => {
    expect(computePasal17(5_100_000_000)).toBe(3_000_000 + 28_500_000 + 62_500_000 + 1_350_000_000 + 35_000_000);
  });

  it('5 lapisan sesuai UU HPP (5/15/25/30/35)', () => {
    expect(PASAL_17_BANDS.map(([, r]) => r)).toEqual([0.05, 0.15, 0.25, 0.3, 0.35]);
  });

  it('titik tengah antar lapis interpolasi benar', () => {
    // PKP 155jt = 60jt@5% + 95jt@15% = 3jt + 14,25jt = 17,25jt
    expect(computePasal17(155_000_000)).toBe(17_250_000);
  });
});

describe('biayaJabatanSetahun — 5%/bln maks 500rb, plafon 6jt', () => {
  it('bruto kecil → 5% penuh tiap bulan', () => {
    expect(biayaJabatanSetahun(Array(12).fill(4_000_000))).toBe(2_400_000); // 12×200rb
  });
  it('bruto besar → dibatasi 500rb/bln = 6jt/tahun', () => {
    expect(biayaJabatanSetahun(Array(12).fill(15_000_000))).toBe(6_000_000);
  });
  it('bruto campuran', () => {
    // 10jt→500rb; 6jt→300rb
    expect(biayaJabatanSetahun([10_000_000, 6_000_000])).toBe(800_000);
  });
  it('bruto 0 / negatif aman', () => {
    expect(biayaJabatanSetahun([0, -100_000])).toBe(0);
  });
});

describe('PTKP tahunan', () => {
  it('sesuai UU HPP', () => {
    expect(PTKP_ANNUAL['TK/0']).toBe(54_000_000);
    expect(PTKP_ANNUAL['TK/1']).toBe(58_500_000);
    expect(PTKP_ANNUAL['K/2']).toBe(67_500_000);
    expect(PTKP_ANNUAL['K/3']).toBe(72_000_000);
  });
});

describe('computeYearEndPph21 — contoh resmi Ryan (ortax)', () => {
  const ryan = () => {
    const monthlyGross = [
      ...Array(5).fill(17_500_000),   // Jan–Mei
      ...Array(7).fill(15_000_000),   // Jun–Des
    ];
    const monthlyPension = Array(12).fill(200_000);
    return computeYearEndPph21({
      monthlyGross, monthlyEmployeePension: monthlyPension,
      ptkp: 'K/2', withheldJanNov: 11_025_000,
    });
  };

  it('bruto setahun & pengurang benar', () => {
    const r = ryan();
    expect(r.annualGross).toBe(192_500_000);
    expect(r.biayaJabatan).toBe(6_000_000);      // 12×500rb
    expect(r.iuranPensiun).toBe(2_400_000);      // 12×200rb
    expect(r.ptkp).toBe(67_500_000);
  });

  it('Pasal 17 → terutang setahun 11.490.000', () => {
    const r = ryan();
    expect(r.pkp).toBe(192_500_000 - 6_000_000 - 2_400_000 - 67_500_000); // 116,6jt
    expect(r.annualTax).toBe(11_490_000);
  });

  it('PPh 21 Desember = terutang − Jan–Nov = 465.000', () => {
    const r = ryan();
    expect(r.dueDecember).toBe(11_490_000 - 11_025_000);
    expect(r.overWithheld).toBe(0);
  });
});

describe('computeYearEndPph21 — kasus tepi', () => {
  it('bruto setahun di bawah PTKP → terutang 0, Desember 0', () => {
    const r = computeYearEndPph21({
      monthlyGross: Array(12).fill(4_000_000),
      monthlyEmployeePension: Array(12).fill(80_000),
      ptkp: 'TK/0', withheldJanNov: 0,
    });
    expect(r.pkp).toBe(0);
    expect(r.annualTax).toBe(0);
    expect(r.dueDecember).toBe(0);
  });

  it('kelebihan potong (Jan–Nov > terutang) → Desember 0 + overWithheld', () => {
    const r = computeYearEndPph21({
      monthlyGross: Array(12).fill(5_000_000),
      monthlyEmployeePension: Array(12).fill(100_000),
      ptkp: 'TK/0', withheldJanNov: 999_000,
    });
    expect(r.annualTax).toBeLessThan(999_000);
    expect(r.dueDecember).toBe(0);
    expect(r.overWithheld).toBe(999_000 - r.annualTax);
  });

  it('setahun tanpa masa → aman (bruto 0)', () => {
    const r = computeYearEndPph21({
      monthlyGross: [], monthlyEmployeePension: [], ptkp: 'TK/0', withheldJanNov: 0,
    });
    expect(r.annualGross).toBe(0);
    expect(r.annualTax).toBe(0);
    expect(r.dueDecember).toBe(0);
    expect(r.effectiveRate).toBe(0);
  });

  it('zakat via pemberi kerja mengurangi PKP', () => {
    const withZakat = computeYearEndPph21({
      monthlyGross: Array(12).fill(10_000_000),
      monthlyEmployeePension: Array(12).fill(200_000),
      ptkp: 'TK/0', zakat: 10_000_000, withheldJanNov: 0,
    });
    const noZakat = computeYearEndPph21({
      monthlyGross: Array(12).fill(10_000_000),
      monthlyEmployeePension: Array(12).fill(200_000),
      ptkp: 'TK/0', withheldJanNov: 0,
    });
    expect(withZakat.pkp).toBe(noZakat.pkp - 10_000_000);
    expect(withZakat.annualTax).toBeLessThan(noZakat.annualTax);
  });

  it('effectiveRate = dueDecember / annualGross', () => {
    const r = computeYearEndPph21({
      monthlyGross: Array(12).fill(10_000_000),
      monthlyEmployeePension: Array(12).fill(200_000),
      ptkp: 'TK/0', withheldJanNov: 0,
    });
    expect(r.effectiveRate).toBeCloseTo(r.dueDecember / 120_000_000, 6);
  });
});
