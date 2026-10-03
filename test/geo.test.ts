// Test modul geo — fondasi geofencing: jarak haversine & tanggal kerja per timezone.
import { describe, it, expect } from 'vitest';
import { distanceMeters, workDateIn, timeIn } from '../src/geo';

describe('distanceMeters (haversine)', () => {
  it('jarak nol di titik yang sama', () => {
    expect(distanceMeters(-6.2, 106.8, -6.2, 106.8)).toBe(0);
  });

  it('Monas ↔ Bundaran HI ± 2,6 km', () => {
    // Dua landmark Jakarta — toleransi 10% cukup untuk memvalidasi rumus.
    const d = distanceMeters(-6.175392, 106.827153, -6.194441, 106.822901);
    expect(d).toBeGreaterThan(2_100);
    expect(d).toBeLessThan(2_900);
  });

  it('radius 300 m: 200 m lolos, 400 m gagal', () => {
    // Geser ~0.0018° lintang ≈ 200 m; 0.0036° ≈ 400 m.
    const base = { lat: -6.2, lng: 106.816666 };
    expect(distanceMeters(base.lat, base.lng, base.lat + 0.0018, base.lng)).toBeLessThan(300);
    expect(distanceMeters(base.lat, base.lng, base.lat + 0.0036, base.lng)).toBeGreaterThan(300);
  });
});

describe('workDateIn / timeIn (zona waktu)', () => {
  it('22:30 UTC = 05:30 WIB besok (Asia/Jakarta, UTC+7)', () => {
    const at = new Date('2026-09-21T22:30:00Z');
    expect(workDateIn('Asia/Jakarta', at)).toBe('2026-09-22');
    expect(timeIn('Asia/Jakarta', at)).toBe('05:30');
  });

  it('shift lintas tengah malam: 20:00 WIB tetap tanggal yang sama', () => {
    const at = new Date('2026-09-21T13:00:00Z'); // 20:00 WIB
    expect(workDateIn('Asia/Jakarta', at)).toBe('2026-09-21');
    expect(timeIn('Asia/Jakarta', at)).toBe('20:00');
  });
});
