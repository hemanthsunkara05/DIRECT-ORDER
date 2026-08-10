import { describe, expect, it } from 'vitest';
import { previousDateKey, toLocalMoment } from '../src/modules/availability/timezone.js';

describe('toLocalMoment (docs/06-business-rules.md BR-69)', () => {
  it('resolves an instant to the restaurant timezone, not UTC', () => {
    // 2026-01-16T19:30:00Z is 2026-01-17T01:00 IST (UTC+5:30) — a different day AND hour than UTC.
    const local = toLocalMoment(new Date('2026-01-16T19:30:00.000Z'), 'Asia/Kolkata');
    expect(local.dateKey).toBe('2026-01-17');
    expect(local.dayOfWeek).toBe(6); // Saturday
    expect(local.minutesOfDay).toBe(60); // 01:00
  });

  it('agrees with UTC for a UTC restaurant', () => {
    const local = toLocalMoment(new Date('2026-01-16T14:15:00.000Z'), 'UTC');
    expect(local.dateKey).toBe('2026-01-16');
    expect(local.dayOfWeek).toBe(5); // Friday
    expect(local.minutesOfDay).toBe(14 * 60 + 15);
  });

  it('handles a negative-offset timezone (date rolls backward)', () => {
    // 2026-01-16T02:00:00Z is 2026-01-15T21:00 in America/New_York (EST, UTC-5 in January).
    const local = toLocalMoment(new Date('2026-01-16T02:00:00.000Z'), 'America/New_York');
    expect(local.dateKey).toBe('2026-01-15');
  });
});

describe('previousDateKey', () => {
  it('steps back one calendar day', () => {
    expect(previousDateKey('2026-01-17')).toBe('2026-01-16');
  });

  it('crosses a month boundary', () => {
    expect(previousDateKey('2026-02-01')).toBe('2026-01-31');
  });

  it('crosses a year boundary', () => {
    expect(previousDateKey('2026-01-01')).toBe('2025-12-31');
  });

  it('handles a leap-day boundary', () => {
    expect(previousDateKey('2026-03-01')).toBe('2026-02-28');
    expect(previousDateKey('2024-03-01')).toBe('2024-02-29');
  });
});
