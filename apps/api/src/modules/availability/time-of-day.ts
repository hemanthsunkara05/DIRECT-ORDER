const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Postgres `TIME` columns (OperatingHours.opensAt/closesAt et al.) round-
 * trip through Prisma Client as a `Date` whose date part is a fixed
 * epoch (1970-01-01 UTC) and whose UTC hour/minute IS the wall-clock
 * time-of-day — never a real calendar date, never itself timezone-
 * shifted (the restaurant's timezone is applied separately, in
 * timezone.ts, to the actual instant being checked). These two
 * functions are the only place that epoch-date convention is encoded.
 */
export function parseTimeOfDay(hhmm: string): Date {
  const match = TIME_PATTERN.exec(hhmm);
  if (!match) {
    throw new TypeError(`Invalid HH:MM time-of-day: ${JSON.stringify(hhmm)}`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return new Date(Date.UTC(1970, 0, 1, hours, minutes, 0, 0));
}

export function formatTimeOfDay(date: Date): string {
  const hours = date.getUTCHours().toString().padStart(2, '0');
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function minutesOfDay(date: Date): number {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}
