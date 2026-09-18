// ─────────────────────────────────────────────────────────────
// Presensia — SQL binding audit (statis).
// Memeriksa SEMUA pernyataan SQL di src/:
//   A. Campuran placeholder `?` polos dan `?N` bernomor (penyebab
//      D1_ERROR "Wrong number of parameter bindings" di produksi).
//   B. Kesenjangan nomor bind (?1, ?3 tanpa ?2) — valid untuk SQLite
//      tapi hampir selalu sisa refactor → ditandai.
//   C. Jumlah argumen .bind() ≠ jumlah placeholder (per statement,
//      sadar-context DB.batch: bind milik prepare() terdekat sebelumnya).
//   D. SQL dinamis (interpolasi template) → ditandai untuk review manual.
// Catatan: duplikasi ?N (mis. `?2 OR ?2`) LEGAL di SQLite dan pola normal
// untuk reusable parameter — TIDAK ditandai.
// Jalankan:  node scripts/audit-sql-binding.mjs   (exit 1 bila ada temuan)
// ─────────────────────────────────────────────────────────────
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

let findings = 0;
let checked = 0;
let manual = 0;

const walk = (dir) => {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) { walk(p); continue; }
    if (f.name.endsWith('.ts')) auditFile(p, readFileSync(p, 'utf8'));
  }
};

/** Posisi akhir string/template literal mulai dari index pembuka. */
function stringEnd(src, start, quote) {
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i;
    i++;
  }
  return i;
}

/** Semua pasangan (sql, line, start, end, interpolated) dari .prepare(...) */
function extractPrepareCalls(src) {
  const out = [];
  let idx = 0;
  while ((idx = src.indexOf('.prepare(', idx)) !== -1) {
    let i = idx + '.prepare('.length;
    while (i < src.length && /\s/.test(src[i])) i++;
    let sql = '', interpolated = false, end = i;
    if (src[i] === "'" || src[i] === '`') {
      end = stringEnd(src, i, src[i]);
      const raw = src.slice(i + 1, end);
      interpolated = src[i] === '`' && raw.includes('${');
      sql = raw.replace(/\$\{[^}]*\}/g, '§');
    }
    out.push({ sql, line: src.slice(0, idx).split('\n').length, argStart: i, argEnd: end, interpolated });
    idx = end;
  }
  return out;
}

/** Placeholder dalam SQL (string literal SQL dibuang agar `?` di dalamnya tak dihitung). */
function placeholders(sql) {
  const clean = sql.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const numbered = [...clean.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
  const plain = (clean.replace(/\?\d+/g, '').match(/\?/g) || []).length;
  return { numbered, plain, max: numbered.length ? Math.max(...numbered) : 0, total: numbered.length + plain };
}

/** Argumen .bind() milik prepare ini: blok .bind(...) pertama SETELAH
 *  argumen prepare ditutup dan SEBELUM .run/.first/.all statement yang sama,
 *  ATAU sebelum akhir elemen batch berikutnya. */
function bindInfo(src, call) {
  let i = call.argEnd + 1; // lewati penutup string sql
  // Cari .bind( berikutnya
  while (i < src.length) {
    const b = src.indexOf('.bind(', i);
    if (b === -1) return { found: false, count: 0, spread: false };
    // Harus terjadi sebelum .run( / .first( / .all( berikutnya
    const nextTerm = src.slice(i, b).search(/\.\s*(run|first|all)\s*\(/);
    if (nextTerm !== -1) return { found: false, count: 0, spread: false };
    // Buka-tutup paren .bind(
    let depth = 0, j = b + '.bind('.length - 1, inStr = null, argsStart = j + 1;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (inStr) { if (ch === inStr && src[j - 1] !== '\\') inStr = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { inStr = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
    }
    const args = src.slice(argsStart, j);
    const spread = /\.\.\./.test(args);
    let depth2 = 0, count = args.trim() ? 1 : 0, s2 = null;
    for (let k = 0; k < args.length; k++) {
      const ch = args[k];
      if (s2) { if (ch === s2 && args[k - 1] !== '\\') s2 = null; continue; }
      if (ch === "'" || ch === '"' || ch === '`') { s2 = ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') depth2++;
      else if (ch === ')' || ch === ']' || ch === '}') depth2--;
      else if (ch === ',' && depth2 === 0) count++;
    }
    return { found: true, count, spread };
  }
  return { found: false, count: 0, spread: false };
}

function auditFile(path, src) {
  const rel = path.replace(ROOT + '/', '');
  for (const call of extractPrepareCalls(src)) {
    if (!/\?/.test(call.sql)) continue;
    checked++;
    const tag = `${rel}:${call.line}`;
    const ph = placeholders(call.sql);
    const bind = bindInfo(src, call);

    // A. campuran ? polos dan ?N → D1 ERROR nyata
    if (ph.numbered.length && ph.plain > 0) {
      findings++;
      console.log(`❌ [A-CAMPUR] ${tag} → ${ph.numbered.length} bernomor + ${ph.plain} polos`);
      console.log(`   ${call.sql.replace(/\s+/g, ' ').slice(0, 140)}`);
      continue;
    }

    const expected = ph.numbered.length ? ph.max : ph.plain;

    // C. kecocokan jumlah bind
    if (bind.found && !bind.spread && bind.count !== expected) {
      findings++;
      console.log(`❌ [C-BIND]   ${tag} → ${bind.count} argumen .bind() vs ${expected} placeholder`);
      console.log(`   ${call.sql.replace(/\s+/g, ' ').slice(0, 140)}`);
    } else if (!bind.found && expected > 0) {
      findings++;
      console.log(`❌ [C-TANPA]  ${tag} → ${expected} placeholder tapi .bind() tidak ditemukan sebelum terminator`);
    }

    // B. kesenjangan nomor (gap) — sah, tapi pola "base + cabang" (mis. ?2 tanpa ?1
    //    pada interpolasi) adalah desain yang disengaja → hanya tandai yang NON-interpolasi.
    if (ph.numbered.length && !call.interpolated) {
      const uniq = [...new Set(ph.numbered)].sort((a, b) => a - b);
      const gaps = [];
      for (let i = 1; i <= ph.max; i++) if (!uniq.includes(i)) gaps.push(i);
      if (gaps.length) {
        findings++;
        console.log(`⚠️  [B-GAP]    ${tag} → nomor tak terpakai: ?${gaps.join(', ?')} (max ?${ph.max}) — sisa refactor?`);
      }
    }

    // D. SQL dinamis → info review manual
    if (call.interpolated) {
      manual++;
      console.log(`ℹ️  [MANUAL]   ${tag} → SQL dinamis (interpolasi) — pastikan bagian dinamis hanya nama kolom/tabel internal`);
    }
  }
}

walk(SRC);
console.log(`\n══ Audit selesai: ${checked} pernyataan diperiksa · ${findings} temuan · ${manual} dinamis (review manual).`);
process.exit(findings > 0 ? 1 : 0);
