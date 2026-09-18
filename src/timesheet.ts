// ─────────────────────────────────────────────────────────────
// Presensia — Payroll pre-processing (timesheet engine).
// Mentah jam masuk/keluar → komponen siap bayar:
//   grossMinutes − breakMinutes = netMinutes
//   lateMinutes (melebihi grace)
//   overtimeMinutes (≥ min, dibulatkan) + multiplier (libur/hari kerja)
// Cross-midnight: keluar < masuk → rentang melintasi tengah malam.
// ─────────────────────────────────────────────────────────────
import type { OrgPolicy } from './policies';

export interface TimesheetRow {
  workDate: string;
  name: string;
  email: string;
  clockIn: string | null;      // HH:MM
  clockOut: string | null;     // HH:MM
  grossMinutes: number;
  breakMinutes: number;
  netMinutes: number;
  netHours: number;            // 2 desimal
  lateMinutes: number;
  overtimeMinutes: number;
  overtimeMultiplier: number;
  status: string;
  flag: string;                // 'ok' | 'ip-mismatch' | 'low-accuracy' | ''
}

const toMin = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export interface RawAttendance {
  work_date: string; clock_in_at: string | null; clock_out_at: string | null;
  status: string; flag: string | null; name: string; email: string;
  shift_start: string | null; shift_end: string | null; grace_minutes: number | null;
}

export const computeTimesheet = (rows: RawAttendance[], policy: OrgPolicy, holidays: Set<string>): TimesheetRow[] =>
  rows.map((r) => {
    const inAt = r.clock_in_at ? new Date(r.clock_in_at) : null;
    const outAt = r.clock_out_at ? new Date(r.clock_out_at) : null;
    const fmt = (d: Date | null): string | null => d
      ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
      : null;

    let gross = 0;
    if (inAt && outAt) {
      let delta = (outAt.getTime() - inAt.getTime()) / 60_000;
      if (delta < 0) delta += 24 * 60; // cross-midnight
      gross = Math.max(0, Math.round(delta));
    }

    const breakMin = gross > 0 ? Math.min(policy.breakMinutes, Math.floor(gross / 2)) : 0;
    const net = Math.max(0, gross - breakMin);

    // Telat = melewati shift start + grace.
    let late = 0;
    if (inAt && r.shift_start) {
      const inMin = toMin(fmt(inAt)!);
      const startMin = toMin(r.shift_start);
      const over = inMin - startMin;
      if (over > (r.grace_minutes ?? 0)) late = over;
    }

    // Lembur = net melebihi durasi shift (atau > 8 jam tanpa shift), ≥ min, dibulatkan.
    let ot = 0;
    if (gross > 0) {
      const shiftMin = r.shift_start && r.shift_end
        ? (() => {
            let d = toMin(r.shift_end) - toMin(r.shift_start);
            if (d <= 0) d += 24 * 60; // cross-midnight shift
            return d;
          })()
        : 480;
      const rawOt = net - shiftMin;
      if (rawOt >= policy.overtime.minMinutes) {
        ot = Math.ceil(rawOt / policy.overtime.roundMinutes) * policy.overtime.roundMinutes;
      }
    }
    const multiplier = holidays.has(r.work_date)
      ? policy.overtime.multiplierHoliday
      : policy.overtime.multiplierWeekday;

    return {
      workDate: r.work_date,
      name: r.name,
      email: r.email,
      clockIn: fmt(inAt),
      clockOut: fmt(outAt),
      grossMinutes: gross,
      breakMinutes: breakMin,
      netMinutes: net,
      netHours: Math.round((net / 60) * 100) / 100,
      lateMinutes: late,
      overtimeMinutes: ot,
      overtimeMultiplier: multiplier,
      status: r.status,
      flag: r.flag ?? '',
    };
  });

export const timesheetCsv = (rows: TimesheetRow[]): string => {
  const esc = (v: unknown): string => {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [
    'Nama,Email,Tanggal,Masuk,Keluar,Gross (mnt),Istirahat (mnt),Net (mnt),Net (jam),Telat (mnt),Lembur (mnt),Multiplier Lembur,Status,Flag',
    ...rows.map((r) => [r.name, r.email, r.workDate, r.clockIn, r.clockOut, r.grossMinutes, r.breakMinutes,
      r.netMinutes, r.netHours.toFixed(2), r.lateMinutes, r.overtimeMinutes, r.overtimeMultiplier, r.status, r.flag]
      .map(esc).join(',')),
  ];
  return `\uFEFF${lines.join('\n')}`;
};
