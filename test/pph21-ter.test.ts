// ─────────────────────────────────────────────────────────────
// Presensia — PPh 21 TER unit test (murni).
// Termasuk contoh resmi: bruto 7.000.000, K/0, TER 1,25% → 87.500
// (dipublikasikan DJP/penyuluhan untuk PP 58/2023).
// ─────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { computePph21Ter, terCategory, terRate, TER_A, TER_B, TER_C } from '../src/domain/payroll/pph21';

describe('PPh 21 TER — kategori & tarif', () => {
  it('kategori dari status PTKP sesuai PMK 168/2023', () => {
    expect(terCategory('TK/0')).toBe('A');
    expect(terCategory('TK/1')).toBe('A');
    expect(terCategory('K/0')).toBe('A');
    expect(terCategory('TK/2')).toBe('B');
    expect(terCategory('K/1')).toBe('B');
    expect(terCategory('TK/3')).toBe('B');
    expect(terCategory('K/2')).toBe('B');
    expect(terCategory('K/3')).toBe('C');
  });

  it('jumlah lapisan tabel == resmi (A=44, B=40, C=41)', () => {
    expect(TER_A.length).toBe(44);
    expect(TER_B.length).toBe(40);
    expect(TER_C.length).toBe(41);
    // Lapisan terakhir selalu 34% (tautan aman).
    for (const t of [TER_A, TER_B, TER_C]) {
      expect(t[t.length - 1]![1]).toBe(0.34);
    }
  });

  it('contoh resmi: bruto 7.000.000 K/0 → TER 1,25% → 87.500', () => {
    expect(terRate(7_000_000, 'K/0')).toBe(0.0125);
    const r = computePph21Ter(7_000_000, 'K/0');
    expect(r.tax).toBe(87_500);
    expect(r.category).toBe('A');
  });

  it('bruto nol / di bawah lapisan pertama → 0%', () => {
    expect(computePph21Ter(4_000_000).tax).toBe(0);
    expect(computePph21Ter(0).tax).toBe(0);
    expect(computePph21Ter(-1_000_000).tax).toBe(0);
  });

  it('lapisan A naik sebagaimana tabel (batas inklusif)', () => {
    expect(terRate(5_400_000, 'TK/0')).toBe(0);        // tepat batas → masih 0%
    expect(terRate(5_400_001, 'TK/0')).toBe(0.0025);   // lewat batas → lapisan berikut
    expect(terRate(6_300_000, 'TK/0')).toBe(0.0075);
    expect(terRate(12_500_000, 'TK/0')).toBe(0.04);
    expect(terRate(50_000_000, 'TK/0')).toBe(0.18);
  });

  it('kategori B dan C punya ambang nol lebih tinggi', () => {
    expect(terRate(5_500_000, 'TK/0')).toBe(0.0025);   // A: sudah kena
    expect(terRate(5_500_000, 'K/1')).toBe(0);         // B: masih 0%
    expect(terRate(6_200_000, 'K/1')).toBe(0);
    expect(terRate(6_200_001, 'K/1')).toBe(0.0025);
    expect(terRate(6_600_000, 'K/3')).toBe(0);         // C: masih 0%
    expect(terRate(9_000_000, 'K/3')).toBe(0.0125);
  });

  it('iuran JHT/JP karyawan mengurangi brutoERN', () => {
    // 6.000.000 − 114.000 (JHT 2% + JP 1% di bawah cap tercapai) = 5.886.000 → lapis 0,25%? 5.886.000 ≤ 5.950.000 → 0,5%
    const r = computePph21Ter(6_000_000, 'TK/0', 114_000);
    expect(r.rate).toBe(0.005);
    expect(r.tax).toBe(Math.round(5_886_000 * 0.005));
  });

  it('DEDUCTIONS tidak pernah menjebak negatif', () => {
    const r = computePph21Ter(5_000_000, 'TK/0', 99_999_999);
    expect(r.grossMonthly).toBe(0);
    expect(r.tax).toBe(0);
  });
});
