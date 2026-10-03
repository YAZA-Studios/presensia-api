// ─────────────────────────────────────────────────────────────
// Presensia — BPJS calculator unit test (murni) + parser konfigurasi org.
// ─────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import {
  computeBpjs, DEFAULT_BPJS_CONFIG, parseBpjsConfig, mergeBpjsConfig,
  JKK_RISK_CLASSES,
} from '../src/domain/payroll/bpjs';

describe('BPJS calculator', () => {
  it('gaji 5 juta: komponen tepat sesuai tarif', () => {
    const r = computeBpjs(5_000_000);
    expect(r.employee.jht).toBe(100_000);            // 2%
    expect(r.company.jht).toBe(185_000);             // 3,7%
    expect(r.company.jkk).toBe(12_000);              // 0,24%
    expect(r.company.jkm).toBe(15_000);              // 0,3%
    expect(r.employee.jp).toBe(50_000);              // 1% (di bawah cap)
    expect(r.company.jp).toBe(100_000);              // 2%
    expect(r.employee.jkp).toBe(3_000);              // 0,06%
    expect(r.company.jkp).toBe(12_000);              // 0,24%
    expect(r.employee.kesehatan).toBe(50_000);       // 1%
    expect(r.company.kesehatan).toBe(200_000);       // 4%
    expect(r.employee.total).toBe(100_000 + 50_000 + 3_000 + 50_000);
  });

  it('JP memakai batas upah (10.547.400)', () => {
    const wage = 20_000_000;
    const r = computeBpjs(wage);
    expect(r.wageBaseJp).toBe(DEFAULT_BPJS_CONFIG.jpWageCap);
    expect(r.employee.jp).toBe(Math.round(DEFAULT_BPJS_CONFIG.jpWageCap * 0.01));
    expect(r.company.jp).toBe(Math.round(DEFAULT_BPJS_CONFIG.jpWageCap * 0.02));
    // JHT/JKM/JKP tanpa cap → dihitung dari gaji penuh.
    expect(r.employee.jht).toBe(400_000);
    expect(r.company.jkm).toBe(60_000);
  });

  it('BPJS Kesehatan memakai batas upah (12.000.000)', () => {
    const r = computeBpjs(30_000_000);
    expect(r.wageBaseKesehatan).toBe(DEFAULT_BPJS_CONFIG.kesehatanWageCap);
    expect(r.employee.kesehatan).toBe(120_000);
    expect(r.company.kesehatan).toBe(480_000);
  });

  it('JKK kelas risiko dapat diubah via config (kelas V = 1,74%)', () => {
    const r = computeBpjs(10_000_000, { ...DEFAULT_BPJS_CONFIG, jkkCompany: 0.0174 });
    expect(r.company.jkk).toBe(174_000);
  });

  it('gaji 0 dan negatif → semua nol, tanpa error', () => {
    for (const wage of [0, -5_000_000]) {
      const r = computeBpjs(wage);
      expect(r.employee.total).toBe(0);
      expect(r.company.total).toBe(0);
    }
  });
});

describe('parseBpjsConfig (app_config org)', () => {
  it('null / JSON rusak → default', () => {
    expect(parseBpjsConfig(null)).toEqual(DEFAULT_BPJS_CONFIG);
    expect(parseBpjsConfig('bukan json {')).toEqual(DEFAULT_BPJS_CONFIG);
    expect(parseBpjsConfig('[1,2]')).toEqual(DEFAULT_BPJS_CONFIG);
    expect(parseBpjsConfig('null')).toEqual(DEFAULT_BPJS_CONFIG);
  });

  it('patch sebagian → field lain ikut default', () => {
    const cfg = parseBpjsConfig(JSON.stringify({ jkkCompany: 0.0174 }));
    expect(cfg.jkkCompany).toBe(0.0174);
    expect(cfg.jhtCompany).toBe(DEFAULT_BPJS_CONFIG.jhtCompany);
    expect(cfg.jpWageCap).toBe(DEFAULT_BPJS_CONFIG.jpWageCap);
  });

  it('nilai liar diabaikan (di luar rentang wajar)', () => {
    const cfg = parseBpjsConfig(JSON.stringify({
      jhtCompany: -0.5,        // negatif → tolak
      jpEmployee: 99,          // > 1 → tolak
      jpWageCap: 10_000_000_000, // plafon tak masuk akal → tolak
      kesehatanWageCap: -1,    // negatif → tolak
      unknownField: 123,       // tak dikenal → abaikan
    }));
    expect(cfg).toEqual(DEFAULT_BPJS_CONFIG);
  });

  it('plafon dirapikan ke integer', () => {
    expect(parseBpjsConfig(JSON.stringify({ jpWageCap: 10_547_400.7 })).jpWageCap).toBe(10_547_401);
    expect(parseBpjsConfig(JSON.stringify({ jpWageCap: 10_547_400.2 })).jpWageCap).toBe(10_547_400);
  });
});

describe('mergeBpjsConfig (patch admin)', () => {
  it('patch valid di atas current', () => {
    const current = { ...DEFAULT_BPJS_CONFIG, jpWageCap: 11_000_000 };
    const next = mergeBpjsConfig(current, { kesehatanWageCap: 15_000_000 });
    expect(next.kesehatanWageCap).toBe(15_000_000);
    expect(next.jpWageCap).toBe(11_000_000); // tetap nilai current
  });

  it('patch tak valid → jatuh ke current, bukan default', () => {
    const current = { ...DEFAULT_BPJS_CONFIG, jhtCompany: 0.05 };
    const next = mergeBpjsConfig(current, { jhtCompany: -1, jpEmployee: 'abc' as unknown as number });
    expect(next.jhtCompany).toBe(0.05);
    expect(next.jpEmployee).toBe(DEFAULT_BPJS_CONFIG.jpEmployee);
  });

  it('patch bukan objek → current tak berubah', () => {
    const current = { ...DEFAULT_BPJS_CONFIG, jkkCompany: 0.0174 };
    expect(mergeBpjsConfig(current, null)).toEqual(current);
    expect(mergeBpjsConfig(current, [1, 2])).toEqual(current);
    expect(mergeBpjsConfig(current, 'x')).toEqual(current);
  });
});

describe('preset kelas risiko JKK', () => {
  it('5 kelas dengan tarif resmi (0,24%–1,74%)', () => {
    expect(JKK_RISK_CLASSES.map((c) => c.id)).toEqual(['I', 'II', 'III', 'IV', 'V']);
    expect(JKK_RISK_CLASSES.map((c) => c.rate)).toEqual([0.0024, 0.0038, 0.0074, 0.0127, 0.0174]);
  });

  it('pemilihan kelas terapkan ke config lalu ke hitungan', () => {
    const kelasV = JKK_RISK_CLASSES.find((c) => c.id === 'V')!;
    const cfg = mergeBpjsConfig(DEFAULT_BPJS_CONFIG, { jkkCompany: kelasV.rate });
    const r = computeBpjs(10_000_000, cfg);
    expect(r.company.jkk).toBe(174_000);
  });
});
