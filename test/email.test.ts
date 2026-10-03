// ─────────────────────────────────────────────────────────────
// Presensia — Brevo email client: perilaku tanpa key (skip aman).
// ─────────────────────────────────────────────────────────────
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendEmail, emailLayout, escapeHtml } from '../src/email';

const env = (extra: Record<string, unknown> = {}) => ({
  APP_NAME: 'Presensia',
  PUBLIC_APP_URL: 'https://app.test',
  ...extra,
}) as Parameters<typeof sendEmail>[0];

const msg = { to: 'user@x.id', subject: 'Tes', html: '<p>halo</p>' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('sendEmail tanpa key', () => {
  it('BREVO_API_KEY kosong → skipped:true, ok:true, tanpa fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const r = await sendEmail(env(), msg);
    expect(r).toMatchObject({ ok: true, skipped: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('BREVO_FROM_EMAIL kosong juga → skipped', async () => {
    const r = await sendEmail(env({ BREVO_API_KEY: 'k' }), msg);
    expect(r.skipped).toBe(true);
  });
});

describe('sendEmail dengan key', () => {
  it('sukses → ok tanpa skipped, memuat messageId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ messageId: 'abc-123' }), { status: 200 },
    )));
    const r = await sendEmail(env({ BREVO_API_KEY: 'k', BREVO_FROM_EMAIL: 'no-reply@x.id' }), msg);
    expect(r).toMatchObject({ ok: true, skipped: false, id: 'abc-123' });
  });

  it('respons error Brevo → ok:false + pesan', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ code: 'invalid_argument', message: 'bad to' }), { status: 400 },
    )));
    const r = await sendEmail(env({ BREVO_API_KEY: 'k', BREVO_FROM_EMAIL: 'no-reply@x.id' }), msg);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('bad to');
  });

  it('fetch melempar jaringan → ok:false, tidak melempar keluar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const r = await sendEmail(env({ BREVO_API_KEY: 'k', BREVO_FROM_EMAIL: 'no-reply@x.id' }), msg);
    expect(r).toMatchObject({ ok: false, skipped: false, error: 'network down' });
  });

  it('payload memuat api-key header & sender', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ messageId: 'm' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await sendEmail(env({ BREVO_API_KEY: 'RAHASIA', BREVO_FROM_EMAIL: 'no-reply@x.id', BREVO_FROM_NAME: 'Presensia' }), msg);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('api.brevo.com');
    const headers = init.headers as Record<string, string>;
    expect(headers['api-key']).toBe('RAHASIA');
    const body = JSON.parse(String(init.body)) as { sender: { email: string }; to: { email: string }[] };
    expect(body.sender.email).toBe('no-reply@x.id');
    expect(body.to[0].email).toBe('user@x.id');
  });
});

describe('emailLayout & escapeHtml', () => {
  it('layout memuat judul & body', () => {
    const html = emailLayout('Judul Tes', '<p>isi</p>');
    expect(html).toContain('Judul Tes');
    expect(html).toContain('isi');
    expect(html).toContain('Presensia');
  });
  it('escapeHtml menetralkan markup', () => {
    expect(escapeHtml('<b>&"x"</b>')).toBe('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;');
  });
});
