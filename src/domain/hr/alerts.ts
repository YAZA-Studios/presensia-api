// ─────────────────────────────────────────────────────────────
// Presensia — Alert HR (murni, tanpa I/O — domain).
// Aturan alert harian:
//   • Kontrak PKWT mendekati akhir → milestone H-60 / H-30 / H-14.
//     Satu kali kirim per milestone (dedupe via alert_log ref).
//     Bila cron baru mulai saat sisa sudah ≤ 14 hari, hanya milestone
//     TERDEKAT yang terkirim — tidak menumpuk alert basi.
//   • Sisa cuti belum terpakai → pengingat bulanan per karyawan
//     (ref per bulan: 'YYYY-MM'), kirim hanya bila sisa > 0.
//   • Digest liabilitas cuti bulanan untuk admin (ref 'digest:YYYY-MM').
// ─────────────────────────────────────────────────────────────

export type ContractMilestone = 'H-60' | 'H-30' | 'H-14';

export const MILESTONES: readonly ContractMilestone[] = ['H-60', 'H-30', 'H-14'];

/** Selisih hari kalender dari `today` (YYYY-MM-DD) ke `date`. Negatif = lewat. */
export const daysUntil = (date: string, today: string): number => {
  const d = new Date(`${date}T00:00:00Z`).getTime();
  const t = new Date(`${today}T00:00:00Z`).getTime();
  if (!Number.isFinite(d) || !Number.isFinite(t)) return Number.NaN;
  return Math.round((d - t) / 86_400_000);
};

/** Milestone terdekat yang layak dikirim untuk sisa hari tertentu.
 *  sisa > 60 → null (belum waktunya); ≤ 14 → H-14; ≤ 30 → H-30; ≤ 60 → H-60;
 *  lewat masa berlaku (negatif) → H-14 (tetap diingatkan agar segera ditindak). */
export const nearestMilestone = (daysLeft: number): ContractMilestone | null => {
  if (!Number.isFinite(daysLeft)) return null;
  if (daysLeft > 60) return null;
  if (daysLeft <= 14) return 'H-14';
  if (daysLeft <= 30) return 'H-30';
  return 'H-60';
};

/** Ref dedupe alert_log: satu kontrak hanya mengirim satu kali per milestone. */
export const contractAlertRef = (email: string, milestone: ContractMilestone): string =>
  `contract:${email}:${milestone}`;

/** Ref dedupe pengingat cuti: satu karyawan satu kali per bulan. */
export const leaveReminderRef = (email: string, month: string): string =>
  `leave:${email}:${month}`;

/** Ref digest cuti bulanan untuk admin. */
export const leaveDigestRef = (month: string): string => `digest:${month}`;

export interface ContractAlertInput {
  employeeName: string;
  employeeEmail: string;
  contractEndDate: string;
  daysLeft: number;
  orgName: string;
}

/** Subjek & baris ringkasan alert kontrak (murni — mudah dites). */
export const contractAlertSubject = (input: ContractAlertInput): string => {
  const milestone = nearestMilestone(input.daysLeft) ?? 'H-14';
  const sisa = input.daysLeft < 0 ? `lewat ${Math.abs(input.daysLeft)} hari` : `${input.daysLeft} hari lagi`;
  return `[Presensia] Kontrak ${input.employeeName} berakhir ${sisa} (${milestone})`;
};

export interface LeaveReminderInput {
  employeeName: string;
  remainingDays: number;
  quotaDays: number;
  year: number;
}

export const leaveReminderSubject = (input: LeaveReminderInput): string =>
  `Sisa cuti Anda ${input.remainingDays} dari ${input.quotaDays} hari ${input.year} — manfaatkan sebelum hangus`;

export interface LeaveDigestInput {
  month: string;
  orgName: string;
  employees: { name: string; remainingDays: number }[];
}

export const leaveDigestSubject = (input: LeaveDigestInput): string =>
  `[${input.orgName}] Liabilitas cuti ${input.month}: ${input.employees.length} karyawan punya sisa cuti`;

/** Pilih milestone yang BELUM terkirim dari daftar ref yang sudah ada.
 *  Returns the nearest milestone not yet recorded, or null if all sent/expired window. */
export const pendingMilestone = (
  daysLeft: number, sentRefs: ReadonlySet<string>, email: string,
): ContractMilestone | null => {
  const milestone = nearestMilestone(daysLeft);
  if (!milestone) return null;
  // Milestone terdekat saja yang dikirim; kalau sudah terkirim, selesai.
  return sentRefs.has(contractAlertRef(email, milestone)) ? null : milestone;
};
