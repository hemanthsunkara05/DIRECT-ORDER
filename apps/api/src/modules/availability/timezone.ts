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

/**
 * The UTC offset (in minutes, east-positive) `timeZone` observes at
 * `date` — derived from `Intl.DateTimeFormat`, not a static table, so
 * it is correct across DST transitions for zones that have them (India
 * itself does not, but this helper is written generically rather than
 * hardcoded to Asia/Kolkata).
 */
function utcOffsetMinutes(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  const asIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return (asIfUtc - date.getTime()) / 60_000;
}

/**
 * Phase 17 (analytics rollups): the UTC instant corresponding to local
 * midnight of `dateKey` (`YYYY-MM-DD`) in `timeZone` — the START
 * boundary of a restaurant's own calendar day (docs/14-acceptance-
 * criteria.md: "timezone-correct daily boundaries"). A two-pass
 * guess-and-correct: the first pass's offset is accurate except within
 * a few hours of a DST transition landing exactly on local midnight, so
 * the second pass re-derives the offset from the corrected instant —
 * moot for Asia/Kolkata (no DST) but correct for any IANA zone.
 */
export function localMidnightToUtc(dateKey: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  let instant = Date.UTC(year!, month! - 1, day, 0, 0, 0);
  for (let pass = 0; pass < 2; pass++) {
    const offset = utcOffsetMinutes(new Date(instant), timeZone);
    instant = Date.UTC(year!, month! - 1, day, 0, 0, 0) - offset * 60_000;
  }
  return new Date(instant);
}

/**
 * `dateKey` (`YYYY-MM-DD`) as a plain calendar-date `Date` — for
 * `@db.Date` columns, which store a calendar label, not an instant
 * (matches `DailyRestaurantMetrics.date`/`DailyPlatformMetrics.date`).
 * Deliberately NOT timezone-shifted, unlike `localMidnightToUtc` above
 * — that answers "what UTC instant is local midnight", this answers
 * "what Date object represents this calendar day". Shared here so a
 * rollup write (which computes `dateKey` via `toLocalMoment` in the
 * restaurant's own timezone) and any later read of the same row use
 * the identical dateKey→Date mapping — found live: a rollup dashboard
 * endpoint had its own inline `new Date(Date.UTC(...))` computed from
 * the SERVER's UTC "today" rather than the restaurant's local "today",
 * so for the several hours each day where UTC's calendar date trails
 * India's (00:00–05:30 IST), the dashboard silently queried the wrong
 * day and reported empty results despite the rollup existing.
 */
export function dateKeyToUtcDate(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day));
}
