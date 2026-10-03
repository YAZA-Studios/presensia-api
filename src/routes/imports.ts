// ─────────────────────────────────────────────────────────────
// Presensia — import karyawan massal (Excel/CSV) + template.
//
// Excel tidak dirender browser sendirian — XLSX diubah jadi CSV
// di sisi FE (SheetJS), lalu CSV dikirim ke sini untuk diproses.
// Parse CSV ditulis manual (quote, escape, koma di dalam nilai).
// ─────────────────────────────────────────────────────────────
import type { Env } from '../env';
import { json, err, nowISO } from '../http';
import { hashPassword } from '../passwords';
import { audit } from '../audit';
import type { SessionClaims } from '../sessions';

interface Ctx { env: Env; claims: SessionClaims }

const requireAdmin = (claims: SessionClaims): Response | null =>
  claims.role === 'employee' ? err('Hanya admin/owner.', 403) : null;

/** ── Parser CSV minimal tapi benar (quote "" dan koma dalam nilai). ── */
const parseCsv = (text: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, ''); // buang BOM Excel
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
};

const ROLE_MAP: Record<string, 'admin' | 'manager' | 'employee'> = {
  admin: 'admin', administrator: 'admin', owner: 'admin',
  manager: 'manager', supervisor: 'manager', atasan: 'manager',
  employee: 'employee', karyawan: 'employee', staff: 'employee', pegawai: 'employee',
};

/** ── GET /employees/import/template — unduh template Excel. ── */
export const importTemplate = async (_ctx: Ctx): Promise<Response> => {
  const XLSX = await import('xlsx');
  const rows = [
    { 'Nama': 'Budi Santoso', 'Email': 'budi@perusahaan.co.id', 'Telepon': '081234567890', 'Peran': 'karyawan', 'Sandi Awal (min 8)': 'ganti1234', 'Atasan (email, opsional)': 'rina@perusahaan.co.id' },
    { 'Nama': 'Rina Wijaya', 'Email': 'rina@perusahaan.co.id', 'Telepon': '081234567891', 'Peran': 'manager', 'Sandi Awal (min 8)': 'ganti1234', 'Atasan (email, opsional)': '' },
  ];
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [{ wch: 24 }, { wch: 30 }, { wch: 16 }, { wch: 12 }, { wch: 22 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Karyawan');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': 'attachment; filename="template-import-karyawan-presensia.xlsx"',
      'Cache-Control': 'no-store',
    },
  });
};

/** ── POST /employees/import — proses CSV hasil unggahan. ──
 *  Body: { csv: string }. Baris pertama = header. Return per-baris:
 *  sukses dibuat / dilewati (sudah ada / tidak valid) + alasannya. */
export const importEmployees = async (request: Request, { env, claims }: Ctx): Promise<Response> => {
  const guard = requireAdmin(claims);
  if (guard) return guard;
  const body = await request.json().catch(() => null) as { csv?: string } | null;
  if (!body?.csv || body.csv.length > 2_000_000) return err('File CSV tidak terbaca (maks 2 MB).');

  const rows = parseCsv(body.csv);
  if (rows.length < 2) return err('File kosong — isi minimal satu baris karyawan di bawah header.');

  // Petakan kolom dari header (fleksibel: urutan bebas, nama mirip diterima).
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (...names: string[]): number => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  const col = {
    name: idx('nama', 'name'),
    email: idx('email'),
    phone: idx('telepon', 'phone', 'no hp', 'hp'),
    role: idx('peran', 'role', 'jabatan'),
    password: idx('sandi', 'password', 'kata sandi'),
    reportsTo: idx('atasan', 'supervisor', 'reports'),
  };
  if (col.name < 0 || col.email < 0) {
    return err('Header tidak dikenal — gunakan kolom "Nama" dan "Email" dari template.');
  }

  const created: string[] = [];
  const results: { email: string; status: 'created' | 'skipped' | 'error'; message: string }[] = [];

  // Baris atasan diproses dulu agar rujukan reports_to selalu valid.
  const dataRows = rows.slice(1);
  const rank = (r: string[]): number => {
    const raw = col.role >= 0 ? (r[col.role] || '').trim().toLowerCase() : '';
    const role: 'admin' | 'manager' | 'employee' = ROLE_MAP[raw] ?? 'employee';
    return role === 'admin' ? 0 : role === 'manager' ? 1 : 2;
  };
  const sorted = [...dataRows].sort((a, b) => rank(a) - rank(b));

  for (const r of sorted) {
    const name = (r[col.name] || '').trim();
    const email = (r[col.email] || '').trim().toLowerCase();
    const phone = col.phone >= 0 ? (r[col.phone] || '').trim() : '';
    const roleRaw = col.role >= 0 ? (r[col.role] || '').trim().toLowerCase() : '';
    const role = ROLE_MAP[roleRaw] ?? 'employee';
    const password = col.password >= 0 ? (r[col.password] || '').trim() : '';
    const reportsTo = col.reportsTo >= 0 ? (r[col.reportsTo] || '').trim().toLowerCase() : '';

    if (!name || !email.includes('@')) {
      results.push({ email: email || '(tanpa email)', status: 'error', message: 'Nama/email tidak valid' });
      continue;
    }
    if (password.length < 8) {
      results.push({ email, status: 'error', message: 'Sandi awal kosong / kurang dari 8 karakter' });
      continue;
    }
    const exists = await env.DB.prepare('SELECT email FROM users WHERE email = ?1').bind(email).first();
    if (exists) {
      results.push({ email, status: 'skipped', message: 'Email sudah terdaftar' });
      continue;
    }
    let supervisor: string | null = null;
    if (reportsTo) {
      const sup = await env.DB.prepare('SELECT email FROM users WHERE email = ?1 AND org_id = ?2')
        .bind(reportsTo, claims.orgId).first();
      if (!sup) {
        results.push({ email, status: 'error', message: `Atasan "${reportsTo}" tidak ditemukan` });
        continue;
      }
      supervisor = reportsTo;
    }
    await env.DB.prepare(
      'INSERT INTO users (email, org_id, name, role, password_hash, email_verified, phone, reports_to, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8)'
    ).bind(email.slice(0, 120), claims.orgId, name.slice(0, 80), role,
      await hashPassword(password), phone.slice(0, 24) || null, supervisor, nowISO()).run();
    created.push(email);
    results.push({ email, status: 'created', message: `dibuat sebagai ${role}` });
  }

  if (created.length) await audit(env, claims.email, 'import-employees', `${created.length} karyawan: ${created.slice(0, 5).join(', ')}${created.length > 5 ? '…' : ''}`);
  return json({
    summary: { created: created.length, skipped: results.filter((r) => r.status === 'skipped').length, failed: results.filter((r) => r.status === 'error').length },
    results,
  }, created.length ? 201 : 200);
};
