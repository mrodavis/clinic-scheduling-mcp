/**
 * Times are clinic-local wall-clock strings, "YYYY-MM-DDTHH:mm", in the clinic's
 * time zone. Arithmetic is done on minutes since the epoch as if the wall clock
 * were UTC, which is exact for same-day math and keeps DST out of slot logic.
 */
export type LocalDateTime = string;
export type LocalDate = string;

export const LOCAL_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
export const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parts(t: LocalDateTime): [number, number, number, number, number] {
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`Invalid local datetime: ${t}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
}

export function toMinutes(t: LocalDateTime): number {
  const [y, mo, d, h, mi] = parts(t);
  return Date.UTC(y, mo - 1, d, h, mi) / 60000;
}

export function fromMinutes(n: number): LocalDateTime {
  return new Date(n * 60000).toISOString().slice(0, 16);
}

export function addMinutes(t: LocalDateTime, minutes: number): LocalDateTime {
  return fromMinutes(toMinutes(t) + minutes);
}

export function dateOf(t: LocalDateTime): LocalDate {
  return t.slice(0, 10);
}

export function addDays(d: LocalDate, days: number): LocalDate {
  return fromMinutes(toMinutes(`${d}T00:00`) + days * 1440).slice(0, 10);
}

/** 0 = Sunday ... 6 = Saturday */
export function dayOfWeek(d: LocalDate): number {
  return new Date(`${d}T00:00:00Z`).getUTCDay();
}

export function ageOn(dob: LocalDate, on: LocalDate): number {
  const [by, bm, bd] = dob.split("-").map(Number) as [number, number, number];
  const [y, m, d] = on.split("-").map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/** Current wall-clock time in the clinic's time zone. */
export function clinicNow(timeZone: string, at = new Date()): LocalDateTime {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
