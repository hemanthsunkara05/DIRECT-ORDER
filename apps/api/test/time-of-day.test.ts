import { describe, expect, it } from 'vitest';
import {
  formatTimeOfDay,
  minutesOfDay,
  parseTimeOfDay,
} from '../src/modules/availability/time-of-day.js';

describe('time-of-day', () => {
  it('round-trips HH:MM through parse/format', () => {
    expect(formatTimeOfDay(parseTimeOfDay('09:30'))).toBe('09:30');
    expect(formatTimeOfDay(parseTimeOfDay('23:59'))).toBe('23:59');
    expect(formatTimeOfDay(parseTimeOfDay('00:00'))).toBe('00:00');
  });

  it('rejects an invalid HH:MM string', () => {
    expect(() => parseTimeOfDay('24:00')).toThrow();
    expect(() => parseTimeOfDay('9:30')).toThrow();
    expect(() => parseTimeOfDay('09:60')).toThrow();
    expect(() => parseTimeOfDay('not-a-time')).toThrow();
  });

  it('computes minutesOfDay from the epoch-date convention', () => {
    expect(minutesOfDay(parseTimeOfDay('00:00'))).toBe(0);
    expect(minutesOfDay(parseTimeOfDay('01:30'))).toBe(90);
    expect(minutesOfDay(parseTimeOfDay('23:59'))).toBe(1439);
  });
});
