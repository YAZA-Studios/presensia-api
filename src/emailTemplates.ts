// ─────────────────────────────────────────────────────────────
// Presensia — Template email transaksional (murni string, tanpa I/O).
//
// Dipakai untuk alur akun: aktivasi email, atur ulang kata sandi, dan
// pemberitahuan perubahan kata sandi. Semua HTML inline-style (aman untuk
// klien email) berbahasa Indonesia, brand hijau Presensia (#2E7D63).
// Nama & URL SELALU di-escape — aman terhadap injeksi HTML.
// Kirim via sendEmail() (Brevo). Tanpa BREVO_API_KEY email di-skip aman.
// ─────────────────────────────────────────────────────────────
import { escapeHtml } from './email';

export const VERIFY_EMAIL_SUBJECT = 'Aktifkan akun Presensia kamu';
export const RESET_PASSWORD_SUBJECT = 'Atur ulang kata sandi Presensia';
export const PASSWORD_CHANGED_SUBJECT = 'Kata sandi Presensia kamu berhasil diubah';

const BRAND = '#2E7D63';

const shell = (title: string, bodyHtml: string, footerNote: string): string => `
<!doctype html>
<html lang="id">
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#F4F7FA;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(title)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F7FA;padding:28px 12px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">
        <tr><td style="padding:0 8px 14px;">
          <span style="font-size:15px;font-weight:700;letter-spacing:.14em;color:#16222E;">PRESENSIA</span>
          <span style="font-size:12px;color:#7A8CA0;">&nbsp;· presisi kehadiran tim</span>
        </td></tr>
        <tr><td style="background:#ffffff;border:1px solid #E4EAF0;border-radius:12px;overflow:hidden;">
          <div style="height:4px;background:${BRAND};"></div>
          <div style="padding:30px 32px 8px;">
            <h1 style="margin:0 0 6px;font-size:20px;line-height:1.35;color:#16222E;">${escapeHtml(title)}</h1>
            ${bodyHtml}
          </div>
          <div style="padding:18px 32px 26px;border-top:1px solid #E4EAF0;margin-top:18px;">
            <p style="margin:0;font-size:12px;line-height:1.6;color:#7A8CA0;">${footerNote}</p>
          </div>
        </td></tr>
      </table>
      <p style="margin:14px 0 0;font-size:11px;color:#9AAAB9;">Email otomatis — mohon jangan dibalas langsung.</p>
    </td></tr>
  </table>
</body>
</html>`;

const paragraph = (html: string): string =>
  `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3A4A5A;">${html}</p>`;

const ctaButton = (url: string, label: string): string =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px auto;"><tr><td align="center" bgcolor="${BRAND}" style="border-radius:9px;">
    <a href="${escapeHtml(url)}" style="display:inline-block;padding:13px 30px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:9px;">${escapeHtml(label)}</a>
  </td></tr></table>`;

const fallbackLink = (url: string): string =>
  `<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#7A8CA0;">
     Jika tombol tidak berfungsi, salin tautan ini ke peramban Anda:<br />
     <a href="${escapeHtml(url)}" style="color:#2E7D63;word-break:break-all;">${escapeHtml(url)}</a>
   </p>`;

const expiryNote = (text: string): string =>
  `<p style="margin:14px 0 0;font-size:13px;color:#8A6D1A;background:#FFF8E6;border:1px solid #F0E3B8;border-radius:8px;padding:10px 14px;">&#9203;&nbsp; ${escapeHtml(text)}</p>`;

const securityNote = (text: string): string =>
  `<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#7A8CA0;">&#128274;&nbsp; ${escapeHtml(text)}</p>`;

interface CtaInput {
  name: string;            // nama penerima (di-escape otomatis)
  url: string;             // tautan aksi (di-escape otomatis)
  expiresInHours?: number; // catatan masa berlaku (jam)
  expiresInMinutes?: number; // catatan masa berlaku (menit)
}

/** Email aktivasi akun — dikirim setelah pendaftaran mandiri. */
export const verifyEmailTemplate = (input: CtaInput): string => {
  const name = escapeHtml(input.name || 'Sahabat');
  const expiry = input.expiresInHours
    ? expiryNote(`Tautan aktivasi berlaku ${input.expiresInHours} jam sejak email ini dikirim.`)
    : '';
  return shell(
    'Aktifkan akun Presensia kamu',
    `
    <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3A4A5A;">Halo <strong>${name}</strong>,</p>
    ${paragraph('Terima kasih telah mendaftar. Satu langkah terakhir: konfirmasi bahwa email ini milik Anda agar akun perusahaan bisa digunakan.')}
    ${ctaButton(input.url, 'Aktifkan Akun')}
    ${expiry}
    ${fallbackLink(input.url)}
    ${securityNote('Jika Anda tidak merasa mendaftar di Presensia, abaikan email ini — akun tidak akan aktif tanpa konfirmasi.')}`,
    `Butuh bantuan? Hubungi tim support Anda atau balas melalui kanal resmi Presensia.`,
  );
};

/** Email atur ulang kata sandi — dikirim saat pemilik akun meminta reset. */
export const resetPasswordTemplate = (input: CtaInput): string => {
  const name = escapeHtml(input.name || 'Sahabat');
  const expiry = input.expiresInMinutes
    ? expiryNote(`Tautan ini berlaku ${input.expiresInMinutes} menit dan hanya bisa dipakai sekali.`)
    : '';
  return shell(
    'Atur ulang kata sandi',
    `
    <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3A4A5A;">Halo <strong>${name}</strong>,</p>
    ${paragraph('Kami menerima permintaan untuk mengatur ulang kata sandi akun Presensia Anda. Klik tombol di bawah untuk membuat kata sandi baru.')}
    ${ctaButton(input.url, 'Atur Ulang Kata Sandi')}
    ${expiry}
    ${fallbackLink(input.url)}
    ${securityNote('Jika Anda tidak meminta pengaturan ulang, abaikan email ini — kata sandi Anda tidak berubah.')}`,
    'Jangan bagikan tautan ini kepada siapa pun — siapa pun yang memegang tautan dapat mengubah kata sandi Anda.',
  );
};

/** Pemberitahuan kata sandi berhasil diubah (tanpa tautan reset).
 *  loginUrl dari PUBLIC_APP_URL pemanggil — opsional. */
export const passwordChangedTemplate = (input: { name: string; when?: string; loginUrl?: string }): string => {
  const name = escapeHtml(input.name || 'Sahabat');
  const when = input.when ? escapeHtml(input.when) : 'baru saja';
  const cta = input.loginUrl ? ctaButton(input.loginUrl, 'Masuk ke Presensia') : '';
  return shell(
    'Kata sandi berhasil diubah',
    `
    <p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#3A4A5A;">Halo <strong>${name}</strong>,</p>
    ${paragraph(`Kata sandi akun Presensia Anda <strong>${when}</strong> telah diubah. Sekarang Anda bisa masuk menggunakan kata sandi baru.`)}
    ${cta}
    ${securityNote('Bukan Anda yang mengubah? Segera hubungi admin organisasi Anda dan ajukan pengaturan ulang kata sandi kembali.')}`,
    'Email keamanan dikirim otomatis setiap kali kata sandi akun diubah.',
  );
};
