// ─────────────────────────────────────────────────────────────
// Presensia — util geolokasi (haversine) & tanggal zona waktu org.
// ─────────────────────────────────────────────────────────────

/** Jarak meter antara dua koordinat (rumus haversine). */
export const distanceMeters = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const R = 6_371_000;
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

/** Tanggal kerja 'YYYY-MM-DD' dalam zona waktu org (WIB default). */
export const workDateIn = (timeZone: string, at: Date = new Date()): string => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return fmt.format(at);
};

/** Jam 'HH:MM' dalam zona waktu org. */
export const timeIn = (timeZone: string, at: Date = new Date()): string => {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false });
  return fmt.format(at);
};
