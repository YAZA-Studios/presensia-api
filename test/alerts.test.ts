// ─────────────────────────────────────────────────────────────
// Presensia — Alert HR domain (unit test murni).
// ─────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import {
  daysUntil, nearestMilestone, pendingMilestone,
  contractAlertRef, leaveReminderRef, leaveDigestRef,
  contractAlertSubject, leaveReminderSubject, leaveDigestSubject,
} from '../src/domain/hr/alerts';

describe('daysUntil', () => {
  it('hitung hari kalender', () => {
    expect(daysUntil('2026-12-01', '2026-10-03')).toBe(59);
    expect(daysUntil('2026-10-03', '2026-10-03')).toBe(0);
    expect(daysUntil('2026-10-01', '2026-10-03')).toBe(-2);
  });
  it('tanggal tak valid → NaN', () => {
    expect(Number.isNaN(daysUntil('bukan-tanggal', '2026-10-03'))).toBe(true);
  });
});

describe('nearestMilestone', () => {
  it('> 60 hari → belum waktunya', () => {
    expect(nearestMilestone(61)).toBeNull();
    expect(nearestMilestone(120)).toBeNull();
    expect(nearestMilestone(Number.NaN)).toBeNull();
  });
  it('ambang H-60, H-30, H-14 inklusif', () => {
    expect(nearestMilestone(60)).toBe('H-60');
    expect(nearestMilestone(45)).toBe('H-60');
    expect(nearestMilestone(31)).toBe('H-60');
    expect(nearestMilestone(30)).toBe('H-30');
    expect(nearestMilestone(20)).toBe('H-30');
    expect(nearestMilestone(15)).toBe('H-30');
    expect(nearestMilestone(14)).toBe('H-14');
    expect(nearestMilestone(0)).toBe('H-14');
  });
  it('kontrak lewat masa berlaku tetap diingatkan (H-14)', () => {
    expect(nearestMilestone(-3)).toBe('H-14');
    expect(nearestMilestone(-40)).toBe('H-14');
  });
});

describe('pendingMilestone (dedupe)', () => {
  it('milestone terdekat belum terkirim → dikirim', () => {
    expect(pendingMilestone(45, new Set(), 'a@x.id')).toBe('H-60');
  });
  it('milestone terdekat sudah terkirim → null (tidak dobel)', () => {
    const sent = new Set([contractAlertRef('a@x.id', 'H-60')]);
    expect(pendingMilestone(45, sent, 'a@x.id')).toBeNull();
  });
  it('berjalan waktu: H-60 terkirim, lalu H-30 muncul → kirim H-30', () => {
    const sent = new Set([contractAlertRef('a@x.id', 'H-60')]);
    expect(pendingMilestone(25, sent, 'a@x.id')).toBe('H-30');
    sent.add(contractAlertRef('a@x.id', 'H-30'));
    expect(pendingMilestone(10, sent, 'a@x.id')).toBe('H-14');
    sent.add(contractAlertRef('a@x.id', 'H-14'));
    expect(pendingMilestone(5, sent, 'a@x.id')).toBeNull();
  });
  it('ref berbeda per email & per milestone', () => {
    expect(contractAlertRef('a@x.id', 'H-30')).not.toBe(contractAlertRef('b@x.id', 'H-30'));
    expect(contractAlertRef('a@x.id', 'H-30')).not.toBe(contractAlertRef('a@x.id', 'H-60'));
    expect(leaveReminderRef('a@x.id', '2026-10')).not.toBe(leaveReminderRef('a@x.id', '2026-11'));
    expect(leaveDigestRef('2026-10')).toBe('digest:2026-10');
  });
});

describe('subjek email', () => {
  it('kontrak memuat milestone & sisa hari', () => {
    const s = contractAlertSubject({
      employeeName: 'Budi', employeeEmail: 'budi@x.id',
      contractEndDate: '2026-11-01', daysLeft: 30, orgName: 'PT Maju',
    });
    expect(s).toContain('Budi');
    expect(s).toContain('30 hari lagi');
    expect(s).toContain('H-30');
  });
  it('kontrak lewat → teks "lewat"', () => {
    const s = contractAlertSubject({
      employeeName: 'Sari', employeeEmail: 'sari@x.id',
      contractEndDate: '2026-09-01', daysLeft: -32, orgName: 'PT Maju',
    });
    expect(s).toContain('lewat 32 hari');
  });
  it('pengingat cuti memuat sisa & kuota', () => {
    const s = leaveReminderSubject({ employeeName: 'Andi', remainingDays: 12, quotaDays: 12, year: 2026 });
    expect(s).toContain('12 dari 12');
    expect(s).toContain('2026');
  });
  it('digest memuat jumlah karyawan', () => {
    const s = leaveDigestSubject({
      month: '2026-10', orgName: 'PT Maju',
      employees: [{ name: 'A', remainingDays: 5 }, { name: 'B', remainingDays: 3 }],
    });
    expect(s).toContain('PT Maju');
    expect(s).toContain('2 karyawan');
  });
});
