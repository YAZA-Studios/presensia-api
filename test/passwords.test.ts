// Test modul passwords — validasi kebijakan sandi & hash/verify PBKDF2.
import { describe, it, expect } from 'vitest';
import { validatePassword, hashPassword, verifyPassword } from '../src/passwords';

describe('validatePassword', () => {
  it('menolak sandi terlalu pendek', () => {
    expect(validatePassword('pendek1')).not.toBeNull(); // 7 karakter
  });
  it('menerima sandi kuat', () => {
    expect(validatePassword('sandi-aman-2026')).toBeNull();
  });
});

describe('hashPassword / verifyPassword (PBKDF2)', () => {
  it('hash diverifikasi benar', async () => {
    const stored = await hashPassword('sandi-aman-2026');
    expect(stored).not.toBe('sandi-aman-2026');
    expect(await verifyPassword('sandi-aman-2026', stored)).toBe(true);
  });
  it('sandi salah ditolak', async () => {
    const stored = await hashPassword('sandi-aman-2026');
    expect(await verifyPassword('sandi-salah-999', stored)).toBe(false);
  });
  it('garam acak: hash dua kali berbeda, keduanya terverifikasi', async () => {
    const a = await hashPassword('kata-sandi-sama');
    const b = await hashPassword('kata-sandi-sama');
    expect(a).not.toBe(b);
    expect(await verifyPassword('kata-sandi-sama', a)).toBe(true);
    expect(await verifyPassword('kata-sandi-sama', b)).toBe(true);
  });
});
