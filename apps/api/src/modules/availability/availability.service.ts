import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../platform/database/prisma.service.js';
import { OperatingHoursRepository } from './repositories/operating-hours.repository.js';
import { SpecialHoursRepository } from './repositories/special-hours.repository.js';
import { ClosurePeriodRepository } from './repositories/closure-period.repository.js';
import { toLocalMoment, previousDateKey, type LocalMoment } from './timezone.js';
import { minutesOfDay } from './time-of-day.js';

export type AvailabilityReason = 'ACCEPTING' | 'SUSPENDED' | 'DISABLED' | 'CLOSED_NOW' | 'ON_BREAK';

export interface AvailabilityDecision {
  accepting: boolean;
  reason: AvailabilityReason;
}

interface Shift {
  opensAt: Date;
  closesAt: Date;
  isClosed: boolean;
}

/**
 * `isAcceptingOrders(restaurantId, at)` — the single availability
 * authority (docs/03-state-machines.md "Ordering availability — one
 * authoritative function", BR-66). Every consumer (this phase's public
 * page, later phases' search "open now" filter and checkout
 * revalidation) calls this and only this, so all three always agree.
 *
 * Precedence, checked in order, first match wins (BR-67):
 * `Restaurant.status` → active `ClosurePeriod` → `SpecialHours` →
 * `OperatingHours` → `Restaurant.orderingEnabled`.
 */
@Injectable()
export class AvailabilityService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OperatingHoursRepository) private readonly hours: OperatingHoursRepository,
    @Inject(SpecialHoursRepository) private readonly specialHours: SpecialHoursRepository,
    @Inject(ClosurePeriodRepository) private readonly closures: ClosurePeriodRepository,
  ) {}

  async isAcceptingOrders(
    restaurantId: string,
    at: Date = new Date(),
  ): Promise<AvailabilityDecision> {
    const restaurant = await this.prisma.restaurant.findUnique({ where: { id: restaurantId } });
    if (!restaurant || restaurant.status !== 'ACTIVE') {
      return { accepting: false, reason: 'SUSPENDED' };
    }

    const activeClosure = await this.closures.findActive(restaurantId, at);
    if (activeClosure) {
      return { accepting: false, reason: 'ON_BREAK' };
    }

    const local = toLocalMoment(at, restaurant.timezone);
    const withinScheduledHours = await this.isWithinScheduledHours(restaurantId, local);
    if (!withinScheduledHours) {
      return { accepting: false, reason: 'CLOSED_NOW' };
    }

    if (!restaurant.orderingEnabled) {
      return { accepting: false, reason: 'DISABLED' };
    }

    return { accepting: true, reason: 'ACCEPTING' };
  }

  /**
   * Resolves "is `local` inside an open shift" by checking two source
   * days: today's shifts (which may extend past midnight into tomorrow)
   * and yesterday's shifts (which may still be open, having started
   * before midnight and not yet closed). Each source day independently
   * prefers SpecialHours over OperatingHours if a SpecialHours row
   * exists for that specific date — a SpecialHours override replaces
   * that day's OperatingHours entirely, it doesn't merge with it.
   */
  private async isWithinScheduledHours(restaurantId: string, local: LocalMoment): Promise<boolean> {
    const yesterdayKey = previousDateKey(local.dateKey);
    const yesterdayDayOfWeek = (local.dayOfWeek + 6) % 7;

    const [todayShifts, yesterdayShifts] = await Promise.all([
      this.shiftsForDate(restaurantId, local.dateKey, local.dayOfWeek),
      this.shiftsForDate(restaurantId, yesterdayKey, yesterdayDayOfWeek),
    ]);

    const openToday = todayShifts.some((shift) => shiftMatches(shift, local.minutesOfDay, 0));
    const openFromYesterday = yesterdayShifts.some((shift) =>
      shiftMatches(shift, local.minutesOfDay, -1),
    );
    return openToday || openFromYesterday;
  }

  private async shiftsForDate(
    restaurantId: string,
    dateKey: string,
    dayOfWeek: number,
  ): Promise<Shift[]> {
    const override = await this.specialHours.findByDate(restaurantId, dateKey);
    if (override) {
      return [
        {
          opensAt: override.opensAt ?? EPOCH,
          closesAt: override.closesAt ?? EPOCH,
          isClosed: override.isClosed,
        },
      ];
    }
    return this.hours.listForDay(restaurantId, dayOfWeek);
  }
}

const EPOCH = new Date(0);

/**
 * Does this shift cover `localMinutes`, given the shift is nominally
 * anchored to "today" (`dayOffset: 0`) or "yesterday" (`dayOffset: -1`)?
 * `closesAt <= opensAt` denotes an overnight shift spanning midnight —
 * from "today"'s anchor that means it's open from `opensAt` through
 * end-of-day; from "yesterday"'s anchor, only the pre-`closesAt`
 * spillover into today counts (docs/01-domain-model.md §5.2).
 */
function shiftMatches(shift: Shift, localMinutes: number, dayOffset: 0 | -1): boolean {
  if (shift.isClosed) return false;

  const opens = minutesOfDay(shift.opensAt);
  const closes = minutesOfDay(shift.closesAt);
  const overnight = closes <= opens;

  if (dayOffset === 0) {
    if (!overnight) return localMinutes >= opens && localMinutes < closes;
    return localMinutes >= opens;
  }

  // dayOffset === -1: only an overnight shift can reach from yesterday into today.
  if (!overnight) return false;
  return localMinutes < closes;
}
