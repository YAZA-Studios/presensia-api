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
import type { PDFPage } from 'pdf-lib';

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


