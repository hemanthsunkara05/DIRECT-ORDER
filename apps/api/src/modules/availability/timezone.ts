/** A specific instant resolved into the restaurant's own wall-clock calendar. */
export interface LocalMoment {
  /** 0 (Sunday) – 6 (Saturday), matching OperatingHours.dayOfWeek. */
  dayOfWeek: number;
  minutesOfDay: number;
  /** `YYYY-MM-DD` in the target timezone — SpecialHours.date's lookup key. */
  dateKey: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Resolves an absolute instant into the restaurant's own timezone
 * (docs/06-business-rules.md BR-69: "evaluated in the restaurant's own
 * timezone, never the server's"). Built on `Intl.DateTimeFormat`
 * (`formatToParts`, not string-parsing) so it's correct across DST
 * transitions and every IANA zone Node ships tzdata for — no manual
 * offset arithmetic, which is exactly the class of bug RISK-12
 * (docs/15-ambiguities-and-risks.md) warns about.
 */
export function toLocalMoment(at: Date, timeZone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  const weekday = get('weekday');
  // hour12:false renders midnight as "24" under some ICU builds — normalize.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));

  return {
    dayOfWeek: WEEKDAY_INDEX[weekday] ?? 0,
    minutesOfDay: hour * 60 + minute,
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

/** `previousDateKey("2026-01-01")` -> `"2025-12-31"`. Pure date-string arithmetic, no timezone involved. */
export function previousDateKey(dateKey: string): string {
  const parts = dateKey.split('-');
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  date.setUTCDate(date.getUTCDate() - 1);
  const y = date.getUTCFullYear();
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}
