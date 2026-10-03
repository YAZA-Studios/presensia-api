// ─────────────────────────────────────────────────────────────
// Presensia — generate PDF rekap PPh 21 tahunan (1721-A1)
// dari payslips. Worker-generated (pdf-lib murni, tanpa I/O).
//
// Catatan: pdf-lib dipakai karena Cloudflare Workers tidak punya
// library PDF native. Library ini adalah murni-JS (tidak ada native
// addon) dan berjalan di lingkungan Workers.
//
// Buat ulang desain PDF jika regulasi formulir 1721-A1 berubah.
// ─────────────────────────────────────────────────────────────
import { PDFDocument, rgb } from 'pdf-lib';
import type { PDFPage, PDFFont } from 'pdf-lib';
import qrcode from 'qrcode-generator';

const COLORS = {
  navy: rgb(0.075, 0.235, 0.353),   // #123C5A
  teal: rgb(0, 0.761, 0.659),       // #00C2A8
  grey: rgb(0.357, 0.42, 0.502),   // #5B6B80
  lightGrey: rgb(0.9, 0.918, 0.941),// #E3E9F0
  white: rgb(1, 1, 1),
  red: rgb(0.9, 0.282, 0.302),      // #E5484D
  amber: rgb(0.96, 0.565, 0.137),   // #F5A623
  cream: rgb(1, 0.94, 0.84),        // latar baris highlighted
};

const PAGE_W = 595.28;  // A4 portrait
const PAGE_H = 841.89;  // A4 portrait
const PADDING = 28;
const ROW_H = 20;

const FONT_HELVETICA = 'Helvetica' as const;
const FONT_HELVETICA_BOLD = 'Helvetica-Bold' as const;
const FONT_COURIER = 'Courier' as const;

const fmtRp = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return '-';
  return new Intl.NumberFormat('id-ID', { 
    style: 'currency', 
    currency: 'IDR', 
    maximumFractionDigits: 0 
  }).format(n);
};

/** Buat PDFDocument baru (pdf-lib 1.17+ returns Promise). */
const createDoc = async (): Promise<PDFDocument> => PDFDocument.create();

/** Embed font standar ke dokumen. */
const embedFont = async (doc: PDFDocument, fontName: 'Helvetica' | 'Helvetica-Bold' | 'Courier') => {
  return doc.embedFont(fontName);
};

/** Buat halaman baru dengan header garis atas. */
const newPage = async (doc: PDFDocument): Promise<PDFPage> => {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const { width, height } = page.getSize();
  
  page.drawRectangle({ x: 0, y: 0, width, height, color: COLORS.white });
  page.drawLine({ start: { x: 0, y: height - 6 }, end: { x: width, y: height - 6 }, thickness: 4, color: COLORS.teal });
  page.drawLine({ start: { x: 0, y: height - 10 }, end: { x: width, y: height - 10 }, thickness: 1, color: COLORS.grey });
  
  return page;
};

/** Gambar footer di halaman. */
const drawFooter = async (doc: PDFDocument, page: PDFPage, pageNum: number, total: number, _generatedAt: string): Promise<void> => {
  const { width } = page.getSize();
  const font = await embedFont(doc, FONT_HELVETICA);
  
  const footerY = 22;
  page.drawLine({ 
    start: { x: PADDING, y: footerY + 6 }, 
    end: { x: width - PADDING, y: footerY + 6 }, 
    thickness: 1, 
    color: COLORS.lightGrey 
  });
  page.drawText(`Presensia · Bukti Potong PPh 21 (1721-A1) · dihasilkan otomatis`, {
    x: PADDING, y: footerY - 4, size: 7, font, color: COLORS.grey,
  });
  page.drawText(`Halaman ${pageNum} dari ${total}`, {
    x: width - PADDING - 60, y: footerY - 4, size: 7, font, color: COLORS.grey,
  });
};

/** Gambar header halaman. */
const drawHeader = async (doc: PDFDocument, page: PDFPage, orgName: string, year: number): Promise<number> => {
  const { width } = page.getSize();
  const font = await embedFont(doc, FONT_HELVETICA);
  const fontBold = await embedFont(doc, FONT_HELVETICA_BOLD);
  
  let y = PAGE_H - 55;
  
  page.drawText(orgName.toUpperCase(), {
    x: PADDING, y, size: 8.5, font, color: COLORS.grey,
  });
  y -= 16;
  page.drawText(`BUKTI POTONG PPh 21 (1721-A1)`, {
    x: PADDING, y, size: 14, font: fontBold, color: COLORS.navy,
  });
  y -= 10;
  page.drawText(`Tahun Pajak ${year}`, {
    x: PADDING, y, size: 11, font, color: COLORS.teal,
  });
  y -= 14;
  page.drawText(`Dasar: rekap PPh 21 karyawan · dihasilkan otomatis dari data payslips`, {
    x: PADDING, y, size: 8, font, color: COLORS.grey,
  });
  y -= 16;
  
  page.drawLine({ 
    start: { x: PADDING, y }, 
    end: { x: width - PADDING, y }, 
    thickness: 1, 
    color: COLORS.teal 
  });
  y -= 10;
  
  return y;
};

interface Column {
  label: string;
  w: number;
}

const TABLE_COLUMNS: Column[] = [
  { label: 'NPWP', w: 62 },
  { label: 'Nama Karyawan', w: 88 },
  { label: 'Email', w: 78 },
  { label: 'PTKP', w: 32 },
  { label: 'Bln', w: 16 },
  { label: 'Bruto Setahun', w: 58 },
  { label: 'Pengurang', w: 50 },
  { label: 'Jan', w: 20 },
  { label: 'Feb', w: 20 },
  { label: 'Mar', w: 20 },
  { label: 'Apr', w: 20 },
  { label: 'Mei', w: 20 },
  { label: 'Jun', w: 20 },
  { label: 'Jul', w: 20 },
  { label: 'Agu', w: 20 },
  { label: 'Sep', w: 20 },
  { label: 'Okt', w: 20 },
  { label: 'Nov', w: 20 },
  { label: 'Des', w: 20 },
  { label: 'Total', w: 44 },
  { label: 'Status', w: 44 },
];

const drawTableHeader = async (doc: PDFDocument, page: PDFPage, y: number): Promise<number> => {
  const { width } = page.getSize();
  const font = await embedFont(doc, FONT_HELVETICA_BOLD);
  
  const totalW = TABLE_COLUMNS.reduce((s, c) => s + c.w, 0);
  const overflow = totalW - (width - 2 * PADDING);
  const startX = PADDING - overflow / 2;
  
  // Background header
  page.drawRectangle({ 
    x: startX - 2, 
    y: y - ROW_H, 
    width: totalW + 4, 
    height: ROW_H, 
    color: COLORS.navy 
  });
  
  // Text header
  let x = startX;
  for (const col of TABLE_COLUMNS) {
    page.drawText(col.label, {
      x: x + 4, 
      y: y - ROW_H + 6, 
      size: 6.5, 
      font, 
      color: COLORS.white,
    });
    x += col.w;
  }
  
  // Garis bawah header
  page.drawLine({ 
    start: { x: startX - 2, y: y - ROW_H }, 
    end: { x: startX - 2 + totalW + 4, y: y - ROW_H }, 
    thickness: 1, 
    color: COLORS.teal 
  });
  
  return y - ROW_H - 4;
};

interface RowData {
  npwp: string;
  name: string;
  email: string;
  ptkp: string;
  months: number;
  bruto: number;
  pengurang: number;
  monthly: number[];
  total: number;
}

const drawRow = async (doc: PDFDocument, page: PDFPage, y: number, data: RowData, highlight: boolean): Promise<number> => {
  const { width } = page.getSize();
  const font = await embedFont(doc, FONT_HELVETICA);
  const fontMono = await embedFont(doc, FONT_COURIER);
  const fontBold = await embedFont(doc, FONT_HELVETICA_BOLD);
  
  const rowY = y - ROW_H;
  
  // Background
  if (highlight) {
    page.drawRectangle({ 
      x: PADDING - 2, 
      y: rowY, 
      width: width - 2 * PADDING + 4, 
      height: ROW_H, 
      color: COLORS.cream 
    });
  }
  
  // Garis antar baris
  page.drawLine({ 
    start: { x: PADDING - 2, y: rowY + ROW_H }, 
    end: { x: width - PADDING + 2, y: rowY + ROW_H }, 
    thickness: 0.5, 
    color: COLORS.lightGrey 
  });
  
  // Text
  const cols: { value: string; w: number; align: 'left' | 'right' | 'center' }[] = [
    { value: data.npwp || '-', w: 62, align: 'left' },
    { value: data.name, w: 88, align: 'left' },
    { value: data.email, w: 78, align: 'left' },
    { value: data.ptkp, w: 32, align: 'left' },
    { value: String(data.months), w: 16, align: 'center' },
    { value: fmtRp(data.bruto), w: 58, align: 'right' },
    { value: fmtRp(data.pengurang), w: 50, align: 'right' },
    { value: fmtRp(data.monthly[0]), w: 20, align: 'right' },
    { value: fmtRp(data.monthly[1]), w: 20, align: 'right' },
    { value: fmtRp(data.monthly[2]), w: 20, align: 'right' },
    { value: fmtRp(data.monthly[3]), w: 20, align: 'right' },
    { value: fmtRp(data.monthly[4]), w: 20, align: 'right' },
    { value: fmtRp(data.monthly[5]), w: 20, align: 'right' },
    { value: fmtRp(data.monthly[6]), w: 20, align: 'right' },
    { value: fmtRp(data.monthly[7]), w: 20, align: 'right' },
    { value: fmtRp(data.monthly[8]), w: 20, align: 'right' },
    { value: fmtRp(data.monthly[9]), w: 20, align: 'right' },
    { value: fmtRp(data.monthly[10]), w: 20, align: 'right' },
    { value: fmtRp(data.monthly[11]), w: 20, align: 'right' },
    { value: fmtRp(data.total), w: 44, align: 'right' },
    { value: data.total > 0 ? 'LUNAS' : 'BELUM', w: 44, align: 'center' },
  ];
  
  let x = PADDING - 2;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const size = i === 1 ? 7.5 : 6.5;
    const f = i === 1 ? font : (i === 4 || i === 20 ? fontBold : fontMono);
    const color = highlight ? COLORS.red : COLORS.navy;
    const tx = col.align === 'right' ? x + col.w - 4 : col.align === 'center' ? x + col.w / 2 : x + 4;
    
    page.drawText(col.value, {
      x: tx, 
      y: rowY + 5, 
      size, 
      font: f, 
      color,
    });
    x += col.w;
  }
  
  return rowY - 1;
};

const drawTotalRow = async (doc: PDFDocument, page: PDFPage, y: number, 
  totalMonths: number, totalBruto: number, totalPengurang: number, 
  totalMonthly: number[], totalAll: number): Promise<number> => {
  const { width } = page.getSize();
  const fontBold = await embedFont(doc, FONT_HELVETICA_BOLD);
  const fontMono = await embedFont(doc, FONT_COURIER);
  
  const rowY = y - ROW_H;
  
  // Background
  page.drawRectangle({ 
    x: PADDING - 2, 
    y: rowY, 
    width: width - 2 * PADDING + 4, 
    height: ROW_H, 
    color: COLORS.lightGrey 
  });
  
  // Garis tebal
  page.drawLine({ 
    start: { x: PADDING - 2, y: rowY + ROW_H }, 
    end: { x: width - PADDING + 2, y: rowY + ROW_H }, 
    thickness: 2, 
    color: COLORS.teal 
  });
  
  const cols: { value: string; w: number; align: 'left' | 'right' | 'center' }[] = [
    { value: 'TOTAL', w: 62, align: 'left' },
    { value: '', w: 88, align: 'left' },
    { value: '', w: 78, align: 'left' },
    { value: '', w: 32, align: 'left' },
    { value: String(totalMonths), w: 16, align: 'center' },
    { value: fmtRp(totalBruto), w: 58, align: 'right' },
    { value: fmtRp(totalPengurang), w: 50, align: 'right' },
    { value: fmtRp(totalMonthly[0]), w: 20, align: 'right' },
    { value: fmtRp(totalMonthly[1]), w: 20, align: 'right' },
    { value: fmtRp(totalMonthly[2]), w: 20, align: 'right' },
    { value: fmtRp(totalMonthly[3]), w: 20, align: 'right' },
    { value: fmtRp(totalMonthly[4]), w: 20, align: 'right' },
    { value: fmtRp(totalMonthly[5]), w: 20, align: 'right' },
    { value: fmtRp(totalMonthly[6]), w: 20, align: 'right' },
    { value: fmtRp(totalMonthly[7]), w: 20, align: 'right' },
    { value: fmtRp(totalMonthly[8]), w: 20, align: 'right' },
    { value: fmtRp(totalMonthly[9]), w: 20, align: 'right' },
    { value: fmtRp(totalMonthly[10]), w: 20, align: 'right' },
    { value: fmtRp(totalMonthly[11]), w: 20, align: 'right' },
    { value: fmtRp(totalAll), w: 44, align: 'right' },
    { value: '', w: 44, align: 'center' },
  ];
  
  let x = PADDING - 2;
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const f = col.value === 'TOTAL' ? fontBold : fontMono;
    const tx = col.align === 'right' ? x + col.w - 4 : col.align === 'center' ? x + col.w / 2 : x + 4;
    
    page.drawText(col.value, {
      x: tx, 
      y: rowY + 5, 
      size: 7.5, 
      font: f, 
      color: COLORS.navy,
    });
    x += col.w;
  }
  
  return rowY - 8;
};

const drawNotes = async (doc: PDFDocument, page: PDFPage, y: number, generatedAt: string): Promise<void> => {
  const font = await embedFont(doc, FONT_HELVETICA);
  const fontBold = await embedFont(doc, FONT_HELVETICA_BOLD);
  
  page.drawText('Keterangan:', {
    x: PADDING, y, size: 7, font: fontBold, color: COLORS.navy,
  });
  y -= 10;
  page.drawText('1. PPh 21 dihitung menggunakan tarif Pasal 17 UU PPh berdasarkan penghasilan kena pajak (bruto dikurangi iuran BPJS karyawan).', {
    x: PADDING, y, size: 6.5, font, color: COLORS.grey,
  });
  y -= 9;
  page.drawText('2. Pengurang iuran adalah iuran JHT + JP karyawan yang dikurangkan dari bruto sebelum menghitung PPh 21.', {
    x: PADDING, y, size: 6.5, font, color: COLORS.grey,
  });
  y -= 9;
  page.drawText('3. Status "LUNAS" = karyawan memiliki PPh 21 > 0 sepanjang tahun. Status "BELUM" = tidak ada PPh 21 yang dipotong.', {
    x: PADDING, y, size: 6.5, font, color: COLORS.grey,
  });
  y -= 9;
  page.drawText(`4. Dokumen ini dihasilkan otomatis pada ${generatedAt} dari data payslips yang ada di sistem.`, {
    x: PADDING, y, size: 6.5, font, color: COLORS.grey,
  });
  
  return;
};

/** Cek apakah y cukup untuk baris berikutnya; jika tidak, buat halaman baru. */
const ensureSpace = async (
  doc: PDFDocument,
  page: PDFPage,
  y: number,
  needed: number,
  pageNum: number,
  totalPages: number,
  generatedAt: string,
): Promise<{ page: PDFPage; y: number }> => {
  if (y - needed < 30) {
    await drawFooter(doc, page, pageNum, totalPages, generatedAt);
    // Halaman lanjutan: tanpa header org (hanya margin atas) — baris tabel berlanjut.
    const nextPage = await newPage(doc);
    return { page: nextPage, y: PAGE_H - 50 };
  }
  return { page, y };
};

/** Generate PDF rekap PPh 21 tahunan (1721-A1) dari aggs.
 *  Satu halaman berisi ~30 baris (header + tabel), multi-halaman jika perlu.
 *  Karyawan dengan PPh 21 > 0 ditandai "LUNAS", yang 0 ditandai "BELUM". */
export const generateAnnualPdf = async (
  orgName: string,
  year: number,
  aggs: RowData[],
  generatedAt: string,
): Promise<Uint8Array> => {
  const doc = await createDoc();
  const ts = new Date(generatedAt);
  const formattedAt = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')} WIB`;
  
  // Hitung total halaman estimasi (untuk footer)
  const rowsPerPage = Math.floor((PAGE_H - 100) / ROW_H) - 5; // kasar
  const totalPages = Math.max(1, Math.ceil(aggs.length / rowsPerPage) + 1);
  
  // Halaman 1
  let page = await newPage(doc);
  let y = await drawHeader(doc, page, orgName, year);
  y = await drawTableHeader(doc, page, y);
  
  let pageNum = 1;
  
  // Data rows
  for (let i = 0; i < aggs.length; i++) {
    const agg = aggs[i];
    const highlight = agg.total > 0 && agg.months === 12;
    
    // Cek halaman baru
    const spaceCheck = await ensureSpace(doc, page, y, ROW_H + 6, pageNum, totalPages, formattedAt);
    if (spaceCheck.page !== page) {
      page = spaceCheck.page;
      y = spaceCheck.y;
      pageNum++;
    }
    
    y = await drawRow(doc, page, y, agg, highlight);
  }
  
  // Baris total
  const totalMonths = aggs.length;
  const totalBruto = aggs.reduce((s, a) => s + a.bruto, 0);
  const totalPengurang = aggs.reduce((s, a) => s + a.pengurang, 0);
  const totalMonthly = Array(12).fill(0);
  for (const a of aggs) {
    for (let i = 0; i < 12; i++) totalMonthly[i] += a.monthly[i];
  }
  const totalAll = aggs.reduce((s, a) => s + a.total, 0);
  
  const spaceCheck = await ensureSpace(doc, page, y, ROW_H + 8, pageNum, totalPages, formattedAt);
  if (spaceCheck.page !== page) {
    page = spaceCheck.page;
    y = spaceCheck.y;
    pageNum++;
  }
  
  y = await drawTotalRow(doc, page, y, totalMonths, totalBruto, totalPengurang, totalMonthly, totalAll);
  y -= 8;
  
  // Notes
  await drawNotes(doc, page, y, formattedAt);
  
  // Footer halaman terakhir
  await drawFooter(doc, page, pageNum, totalPages, formattedAt);
  
  const pdfBytes = await doc.save();
  return pdfBytes;
};

/** Gambar matriks QR sebagai kotak hitam (murni vektor PDF, tanpa gambar).
 *  @param x kiri-atas X · @param y kiri-atas Y (koordinat PDF dari bawah). */
const drawQr = (page: PDFPage, x: number, y: number, size: number, text: string): void => {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cell = size / n;
  page.drawRectangle({ x, y, width: size, height: size, color: COLORS.white });
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      page.drawRectangle({
        x: x + c * cell,
        y: y + size - (r + 1) * cell,
        width: cell + 0.15,
        height: cell + 0.15,
        color: COLORS.navy,
      });
    }
  }
};

const MONTH_NAMES = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** PDF bukti potong 1721-A1 untuk SATU karyawan — layout formal satu halaman:
 *  identitas, rincian PPh 21 per bulan, total, blok tanda tangan elektronik
 *  dengan QR verifikasi + kode segel HMAC (dapat diverifikasi publik). */
export const generateEmployeePdf = async (
  orgName: string,
  year: number,
  data: RowData,
  opts: { verifyUrl: string; sealCode: string; issuedAt: string },
): Promise<Uint8Array> => {
  const doc = await createDoc();
  const page = await newPage(doc);
  const { width } = page.getSize();
  const ts = new Date(opts.issuedAt);
  const issuedLabel = `${ts.getDate()} ${MONTH_NAMES[ts.getMonth()]} ${ts.getFullYear()} ${String(ts.getHours()).padStart(2, '0')}:${String(ts.getMinutes()).padStart(2, '0')} WIB`;

  let y = await drawHeader(doc, page, orgName, year);
  const font = await embedFont(doc, FONT_HELVETICA);
  const fontBold = await embedFont(doc, FONT_HELVETICA_BOLD);
  const fontMono = await embedFont(doc, FONT_COURIER);

  // ── Identitas pemotong & pekerja ──
  page.drawRectangle({ x: PADDING - 2, y: y - 92, width: width - 2 * PADDING + 4, height: 92, color: rgb(0.965, 0.976, 0.984) });
  const idRows: [string, string][] = [
    ['Nama pekerja', data.name],
    ['NPWP', data.npwp || '—'],
    ['Email', data.email],
    ['Status PTKP', data.ptkp],
    ['Jumlah bulan berslip', `${data.months} bulan`],
  ];
  let iy = y - 18;
  for (const [label, value] of idRows) {
    page.drawText(label, { x: PADDING + 4, y: iy, size: 8.5, font, color: COLORS.grey });
    page.drawText(value, { x: PADDING + 120, y: iy, size: 9.5, font: label === 'Nama pekerja' ? fontBold : font, color: COLORS.navy });
    iy -= 16;
  }
  y -= 104;

  // ── Kolom kiri: rincian PPh 21 per bulan ──
  const tableW = 300;
  page.drawText('RINCIAN PPh 21 DIPOTONG', { x: PADDING, y, size: 8.5, font: fontBold, color: COLORS.navy });
  y -= 14;
  const rowH = 19;
  page.drawRectangle({ x: PADDING, y: y - rowH * 14, width: tableW, height: rowH * 14, color: COLORS.white });
  page.drawRectangle({ x: PADDING, y: y - rowH, width: tableW, height: rowH, color: COLORS.navy });
  page.drawText('Bulan', { x: PADDING + 8, y: y - rowH + 6, size: 7.5, font: fontBold, color: COLORS.white });
  page.drawText('PPh 21 (Rp)', { x: PADDING + tableW - 78, y: y - rowH + 6, size: 7.5, font: fontBold, color: COLORS.white });
  let ty = y - rowH;
  const rightText = (text: string, tx: number, yPos: number, f: PDFFont, size: number, color = COLORS.navy): void => {
    const w = f.widthOfTextAtSize(text, size);
    page.drawText(text, { x: tx - w, y: yPos, size, font: f, color });
  };
  for (let m = 0; m < 12; m++) {
    ty -= rowH;
    if (m % 2 === 1) page.drawRectangle({ x: PADDING, y: ty, width: tableW, height: rowH, color: rgb(0.969, 0.976, 0.984) });
    page.drawText(MONTH_NAMES[m]!, { x: PADDING + 8, y: ty + 6, size: 8, font, color: COLORS.navy });
    const val = data.monthly[m]! > 0 ? new Intl.NumberFormat('id-ID').format(data.monthly[m]!) : '—';
    rightText(val, PADDING + tableW - 8, ty + 6, fontMono, 8);
  }
  // Baris TOTAL (latar krem)
  ty -= rowH;
  page.drawRectangle({ x: PADDING, y: ty, width: tableW, height: rowH, color: COLORS.cream });
  page.drawText('TOTAL', { x: PADDING + 8, y: ty + 6, size: 8.5, font: fontBold, color: COLORS.navy });
  rightText(new Intl.NumberFormat('id-ID').format(data.total), PADDING + tableW - 8, ty + 6, fontBold, 8.5);
  // garis penutup tabel
  page.drawRectangle({ x: PADDING, y: ty, width: tableW, height: 1, color: COLORS.teal });

  // ── Kolom kanan: QR + segel + tanda tangan elektronik ──
  const rx = PADDING + tableW + 26;
  const qrSize = 104;
  drawQr(page, rx, y - qrSize + 14, qrSize, opts.verifyUrl);
  let ry = y - qrSize + 14 - 14;
  page.drawText('Pindai QR untuk verifikasi keabsahan', { x: rx, y: ry, size: 7, font, color: COLORS.grey });
  ry -= 11;
  page.drawText('Kode verifikasi:', { x: rx, y: ry, size: 7.5, font, color: COLORS.grey });
  ry -= 12;
  page.drawText(opts.sealCode, { x: rx, y: ry, size: 9.5, font: fontMono, color: COLORS.teal });
  ry -= 22;
  page.drawText(`Diterbitkan elektronik: ${issuedLabel}`, { x: rx, y: ry, size: 7, font, color: COLORS.grey });
  ry -= 34;
  // Blok tanda tangan
  page.drawText(`${orgName}`, { x: rx, y: ry, size: 9, font: fontBold, color: COLORS.navy });
  ry -= 11;
  page.drawText('Tanda tangan elektronik tersegel', { x: rx, y: ry, size: 7.5, font, color: COLORS.grey });
  ry -= 11;
  page.drawText('(dokumen + QR + kode HMAC unik)', { x: rx, y: ry, size: 7.5, font, color: COLORS.grey });
  ry -= 26;
  page.drawLine({ start: { x: rx, y: ry }, end: { x: rx + 130, y: ry }, thickness: 0.8, color: COLORS.teal });
  ry -= 10;
  page.drawText('Presensia — HR & Payroll', { x: rx, y: ry, size: 7, font, color: COLORS.grey });

  // Catatan kaki kiri (di bawah tabel bulanan)
  const noteY = Math.min(ty, 64) - 6;
  page.drawText('Keterangan:', { x: PADDING, y: noteY, size: 6.5, font: fontBold, color: COLORS.navy });
  page.drawText('1. PPh 21 dipotong pemberi kerja sesuai tarif TER (PP 58/2023) dan/atau Pasal 17 UU PPh (Desember).', {
    x: PADDING, y: noteY - 9, size: 6.5, font, color: COLORS.grey,
  });
  page.drawText('2. Pengurang = iuran JHT + JP karyawan. Keabsahan dokumen dapat diperiksa lewat QR / kode verifikasi.', {
    x: PADDING, y: noteY - 18, size: 6.5, font, color: COLORS.grey,
  });

  await drawFooter(doc, page, 1, 1, issuedLabel);
  return doc.save();
};


