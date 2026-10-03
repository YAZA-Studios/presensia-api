// ─────────────────────────────────────────────────────────────
// Presensia — THR (BR-13) unit test.
// Aturan yang diuji:
//   • masa kerja ≥ 12 bulan → THR penuh = 1 bulan gaji
//   • masa kerja < 12 bulan → proporsional (masa ÷ 12) × 1 bulan gaji
//   • masa kerja ≥ 1 bulan sudah berhak (Permenaker 6/2016)
//   • tanpa tanggal masuk / gaji → tidak dihitung (alasan eksplisit)
// ─────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import {
  computeThr, tenureMonths,
  DEFAULT_THR_CONFIG, parseThrConfig, mergeThrConfig,
} from '../src/domain/payroll/thr';

describe('tenureMonths — bulan penuh hire → ref', () => {
  it('tepat 12 bulan (hari ulang tahun sama) → 12', () => {
    expect(tenureMonths('2025-01-15', '2026-01-15')).toBe(12);
    expect(tenureMonths('2024-03-31', '2025-03-31')).toBe(12);
  });

  it('11 bulan 29 hari → 11 (belum genap setahun)', () => {
    expect(tenureMonths('2025-01-15', '2026-01-14')).toBe(11);
  });

  it('hari pertama kerja → 0 bulan', () => {
    expect(tenureMonths('2025-06-01', '2025-06-01')).toBe(0);
    expect(tenureMonths('2025-06-15', '2025-06-30')).toBe(0);
  });

  it('refDate sebelum hireDate → 0', () => {
    expect(tenureMonths('2025-06-01', '2025-05-31')).toBe(0);
  });

  it('format tanggal rusak → 0', () => {
    expect(tenureMonths('', '2026-01-01')).toBe(0);
    expect(tenureMonths('2025-13-40', '2026-01-01')).toBe(0);
    expect(tenureMonths('01/06/2025', '2026-01-01')).toBe(0);
  });

  it('29 Feb → 28 Feb tahun berikut = setahun (KUHPerdata ps. 124)', () => {
    expect(tenureMonths('2024-02-29', '2025-02-28')).toBe(12);
    expect(tenureMonths('2024-02-29', '2025-02-27')).toBe(11);
  });

  it('31 Jan → 28 Feb = 1 bulan (akhir bulan tujuan)', () => {
    expect(tenureMonths('2025-01-31', '2025-02-28')).toBe(1);
    expect(tenureMonths('2025-01-31', '2025-03-30')).toBe(1);  // blm 31 Mar
    expect(tenureMonths('2025-01-31', '2025-03-31')).toBe(2);
  });

  it('masa kerja lintas tahun', () => {
    expect(tenureMonths('2023-08-01', '2026-07-31')).toBe(35);
    expect(tenureMonths('2023-08-01', '2026-08-01')).toBe(36);
  });
});

describe('computeThr — BR-13 prorata masa kerja', () => {
  const refDate = '2026-03-20';

  it('≥ 12 bulan → THR penuh = 1 bulan gaji (factor 1)', () => {
    const r = computeThr({ baseSalary: 10_000_000, hireDate: '2025-03-20', refDate });
    expect(r.eligible).toBe(true);
    expect(r.full).toBe(true);
    expect(r.monthsWorked).toBe(12);
    expect(r.prorataFactor).toBe(1);
    expect(r.amount).toBe(10_000_000);
    expect(r.reason).toBeNull();
  });

  it('masa kerja jauh > 12 bulan tetap THR penuh', () => {
    const r = computeThr({ baseSalary: 8_000_000, hireDate: '2019-01-01', refDate });
    expect(r.full).toBe(true);
    expect(r.amount).toBe(8_000_000);
    expect(r.monthsWorked).toBeGreaterThan(12);
  });

  it('11 bulan → prorata 11/12 (boundary belum penuh)', () => {
    const r = computeThr({ baseSalary: 12_000_000, hireDate: '2025-04-20', refDate });
    expect(r.monthsWorked).toBe(11);
    expect(r.full).toBe(false);
    expect(r.prorataFactor).toBeCloseTo(11 / 12, 10);
    expect(r.amount).toBe(Math.round(12_000_000 * 11 / 12)); // 11.000.000
  });

  it('5 bulan gaji 12jt → 5.000.000 (contoh prorata BR-13)', () => {
    const r = computeThr({ baseSalary: 12_000_000, hireDate: '2025-10-20', refDate });
    expect(r.monthsWorked).toBe(5);
    expect(r.amount).toBe(5_000_000);
  });

  it('pembulatan rupiah untuk prorata non-bulat', () => {
    // 10.000.000 × 5/12 = 4.166.666,67 → 4.166.667
    const r = computeThr({ baseSalary: 10_000_000, hireDate: '2025-10-19', refDate });
    expect(r.monthsWorked).toBe(5);
    expect(r.amount).toBe(4_166_667);
  });

  it('1 bulan kerja → tetap berhak (minMonths default 1)', () => {
    const r = computeThr({ baseSalary: 3_600_000, hireDate: '2026-02-20', refDate });
    expect(r.monthsWorked).toBe(1);
    expect(r.eligible).toBe(true);
    expect(r.amount).toBe(300_000); // 3,6jt ÷ 12
  });

  it('hari pertama kerja (0 bulan) → tidak berhak', () => {
    const r = computeThr({ baseSalary: 5_000_000, hireDate: '2026-03-01', refDate });
    expect(r.eligible).toBe(false);
    expect(r.amount).toBe(0);
    expect(r.monthsWorked).toBe(0);
    expect(r.reason).toContain('di bawah minimum');
  });

  it('tanggal masuk kerja belum diisi → tidak berhak + alasan', () => {
    for (const hireDate of [null, undefined, '', 'bukan-tanggal']) {
      const r = computeThr({ baseSalary: 10_000_000, hireDate, refDate });
      expect(r.eligible).toBe(false);
      expect(r.amount).toBe(0);
      expect(r.reason).toBe('Tanggal masuk kerja belum diisi.');
    }
  });

  it('gaji pokok 0 → tidak berhak + alasan (masa kerja tetap dilaporkan)', () => {
    const r = computeThr({ baseSalary: 0, hireDate: '2020-01-01', refDate });
    expect(r.eligible).toBe(false);
    expect(r.amount).toBe(0);
    expect(r.monthsWorked).toBeGreaterThan(12);
    expect(r.reason).toBe('Gaji pokok belum diisi.');
  });

  it('tanggal masuk setelah tanggal acuan → 0 bulan, tidak berhak', () => {
    const r = computeThr({ baseSalary: 10_000_000, hireDate: '2026-12-01', refDate });
    expect(r.monthsWorked).toBe(0);
    expect(r.eligible).toBe(false);
  });

  it('config kebijakan: THR 2 bulan gaji (multiplier 2)', () => {
    const r = computeThr({
      baseSalary: 10_000_000, hireDate: '2020-01-01', refDate,
      config: { multiplier: 2 },
    });
    expect(r.amount).toBe(20_000_000);
    expect(r.full).toBe(true);
  });

  it('config: masa kerja penuh 24 bulan → prorata memakai 24', () => {
    const r = computeThr({
      baseSalary: 12_000_000, hireDate: '2025-04-20', refDate, // 11 bulan
      config: { monthsForFull: 24 },
    });
    expect(r.full).toBe(false);
    expect(r.prorataFactor).toBeCloseTo(11 / 24, 10);
    expect(r.amount).toBe(5_500_000);
  });

  it('config: minimum masa kerja 3 bulan → 2 bulan ditolak', () => {
    const r = computeThr({
      baseSalary: 6_000_000, hireDate: '2026-01-19', refDate, // 2 bulan
      config: { minMonths: 3 },
    });
    expect(r.eligible).toBe(false);
    expect(r.monthsWorked).toBe(2);
    expect(r.reason).toContain('di bawah minimum 3');
  });

  it('config patch tak dikenal / nilai liar diabaikan (tetap default)', () => {
    const r = computeThr({
      baseSalary: 12_000_000, hireDate: '2025-10-20', refDate,
      config: { monthsForFull: 0, multiplier: -1, minMonths: 999, junk: 5 } as never,
    });
    expect(r.monthsWorked).toBe(5);
    expect(r.amount).toBe(5_000_000); // tetap 5/12 × 1 bulan gaji
  });
});

describe('parseThrConfig / mergeThrConfig — BR-24 config per org', () => {
  it('null / JSON rusak → default', () => {
    expect(parseThrConfig(null)).toEqual(DEFAULT_THR_CONFIG);
    expect(parseThrConfig('')).toEqual(DEFAULT_THR_CONFIG);
    expect(parseThrConfig('{oops')).toEqual(DEFAULT_THR_CONFIG);
    expect(parseThrConfig('[1,2]')).toEqual(DEFAULT_THR_CONFIG);
  });

  it('parse nilai valid', () => {
    expect(parseThrConfig(JSON.stringify({ monthsForFull: 6, multiplier: 1.5, minMonths: 0 })))
      .toEqual({ monthsForFull: 6, multiplier: 1.5, minMonths: 0 });
  });

  it('parse: nilai di luar rentang diabaikan (tetap default)', () => {
    expect(parseThrConfig(JSON.stringify({ monthsForFull: 0, multiplier: 100, minMonths: -5 })))
      .toEqual(DEFAULT_THR_CONFIG);
  });

  it('merge patch sebagian ke current', () => {
    const next = mergeThrConfig(DEFAULT_THR_CONFIG, { multiplier: 2 });
    expect(next).toEqual({ ...DEFAULT_THR_CONFIG, multiplier: 2 });
    // current tidak berubah (immutable)
    expect(DEFAULT_THR_CONFIG.multiplier).toBe(1);
  });

  it('merge patch tak dikenal / salah tipe → current tak berubah', () => {
    expect(mergeThrConfig(DEFAULT_THR_CONFIG, { foo: 1 })).toEqual(DEFAULT_THR_CONFIG);
    expect(mergeThrConfig(DEFAULT_THR_CONFIG, { multiplier: 'dua' })).toEqual(DEFAULT_THR_CONFIG);
    expect(mergeThrConfig(DEFAULT_THR_CONFIG, null)).toEqual(DEFAULT_THR_CONFIG);
  });

  it('merge clamp: multiplier > 12 ditolak', () => {
    const cur = { monthsForFull: 12, multiplier: 1, minMonths: 1 };
    expect(mergeThrConfig(cur, { multiplier: 50 })).toEqual(cur);
  });
});
