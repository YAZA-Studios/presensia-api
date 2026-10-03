// ─────────────────────────────────────────────────────────────
// Presensia — unit test template email transaksional.
// Fokus: konten bahasa Indonesia, URL selalu ada (tombol + fallback),
// nama & URL di-escape (anti injeksi HTML), catatan kedaluwarsa.
// ─────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import {
  verifyEmailTemplate, resetPasswordTemplate, passwordChangedTemplate,
  VERIFY_EMAIL_SUBJECT, RESET_PASSWORD_SUBJECT, PASSWORD_CHANGED_SUBJECT,
} from '../src/emailTemplates';

const URL_TES = 'https://presensia-fe.pages.dev/#/verifikasi-email?token=abc123';

describe('verifyEmailTemplate — aktivasi akun', () => {
  const html = verifyEmailTemplate({ name: 'Budi Santoso', url: URL_TES, expiresInHours: 48 });

  it('URL muncul di tombol DAN tautan fallback', () => {
    expect(html.match(new RegExp(URL_TES.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length).toBeGreaterThanOrEqual(2);
  });

  it('memuat sapaan nama, ajakan, dan brand', () => {
    expect(html).toContain('Budi Santoso');
    expect(html).toContain('Aktifkan Akun');
    expect(html).toContain('PRESENSIA');
  });

  it('menyertakan catatan masa berlaku 48 jam', () => {
    expect(html).toContain('48 jam');
  });

  it('aman dari injeksi HTML pada nama', () => {
    const evil = verifyEmailTemplate({ name: '<img src=x onerror=alert(1)>', url: URL_TES });
    expect(evil).not.toContain('<img src=x');
    expect(evil).toContain('&lt;img src=x');
  });

  it('aman dari injeksi pada URL (tanda kutip di-escape)', () => {
    const evil = verifyEmailTemplate({ name: 'Budi', url: 'https://x.test/"onmouseover="alert(1)' });
    expect(evil).not.toContain('href="https://x.test/"onmouseover=');
  });

  it('tanpa nama tetap sopan (fallback "Sahabat")', () => {
    expect(verifyEmailTemplate({ name: '', url: URL_TES })).toContain('Sahabat');
  });
});

describe('resetPasswordTemplate — atur ulang kata sandi', () => {
  const html = resetPasswordTemplate({ name: 'Siti', url: URL_TES, expiresInMinutes: 60 });

  it('berisi CTA reset + peringatan masa berlaku 60 menit + sekali pakai', () => {
    expect(html).toContain('Atur Ulang Kata Sandi');
    expect(html).toContain('60 menit');
    expect(html).toContain('hanya bisa dipakai sekali');
  });

  it('berisi peringatan jangan bagikan tautan', () => {
    expect(html).toContain('Jangan bagikan');
  });

  it('berisi jalan keluar "abaikan email" untuk pemilik akun', () => {
    expect(html).toContain('tidak meminta');
  });
});

describe('passwordChangedTemplate — pemberitahuan keamanan', () => {
  it('tanpa loginUrl → tanpa CTA', () => {
    const html = passwordChangedTemplate({ name: 'Budi' });
    expect(html).not.toContain('href=');
    expect(html).toContain('telah diubah');
    expect(html).toContain('Bukan Anda');
  });

  it('dengan loginUrl → tombol masuk', () => {
    const html = passwordChangedTemplate({ name: 'Budi', loginUrl: 'https://app.test/#/masuk', when: '2026-10-03 19:00 UTC' });
    expect(html).toContain('https://app.test/#/masuk');
    expect(html).toContain('2026-10-03 19:00 UTC');
  });
});

describe('subjek email', () => {
  it('berbahasa Indonesia dan tidak kosong', () => {
    expect(VERIFY_EMAIL_SUBJECT).toContain('Aktifkan');
    expect(RESET_PASSWORD_SUBJECT).toContain('kata sandi');
    expect(PASSWORD_CHANGED_SUBJECT).toContain('diubah');
  });
});
