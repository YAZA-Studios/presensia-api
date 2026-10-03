// ─────────────────────────────────────────────────────────────
// Presensia — unit test generator PDF 1721-A1 (payrollPdf).
// Fokus: PDF valid (magic bytes %PDF), multi-halaman, dan angka
// tidak crash untuk input kosong.
// ─────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import { generateAnnualPdf } from '../src/payrollPdf';

const agg = (name: string, total: number, monthly?: number[]) => ({
  npwp: '123456789012345',
  name,
  email: `${name.toLowerCase()}@example.com`,
  ptkp: 'TK/0',
  months: 12,
  bruto: 60_000_000,
  pengurang: 7_200_000,
  monthly: monthly ?? Array(12).fill(total / 12),
  total,
});

describe('generateAnnualPdf (PDF 1721-A1)', () => {
  it('menghasilkan PDF valid (diawali %PDF) untuk beberapa karyawan', async () => {
    const bytes = await generateAnnualPdf(
      'PT Contoh Sukses',
      2026,
      [agg('Andi', 1_200_000), agg('Budi', 0, Array(12).fill(0)), agg('Citra', 465_000)],
      '2026-10-03T10:00:00.000Z',
    );
    const head = new TextDecoder().decode(bytes.slice(0, 5));
    expect(head).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(500);
  });

  it('tetap menghasilkan PDF valid saat daftar karyawan kosong', async () => {
    const bytes = await generateAnnualPdf('PT Kosong', 2026, [], '2026-10-03T10:00:00.000Z');
    const head = new TextDecoder().decode(bytes.slice(0, 5));
    expect(head).toBe('%PDF-');
  });

  it('multi-halaman: 60 karyawan menghasilkan PDF yang lebih besar dari 1 karyawan', async () => {
    const banyak = Array.from({ length: 60 }, (_, i) => agg(`Karyawan${i}`, 100_000 + i));
    const bytesBanyak = await generateAnnualPdf('PT Besar', 2026, banyak, '2026-10-03T10:00:00.000Z');
    const bytesSatu = await generateAnnualPdf('PT Kecil', 2026, [agg('Andi', 1_200_000)], '2026-10-03T10:00:00.000Z');
    expect(bytesBanyak.length).toBeGreaterThan(bytesSatu.length);
  });
});
