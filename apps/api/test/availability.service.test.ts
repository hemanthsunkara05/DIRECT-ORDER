import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { AvailabilityService } from '../src/modules/availability/availability.service.js';
import { OperatingHoursRepository } from '../src/modules/availability/repositories/operating-hours.repository.js';
import { SpecialHoursRepository } from '../src/modules/availability/repositories/special-hours.repository.js';
import { ClosurePeriodRepository } from '../src/modules/availability/repositories/closure-period.repository.js';
import { parseTimeOfDay } from '../src/modules/availability/time-of-day.js';
import { createInMemoryPrisma, type InMemoryPrisma } from './support/in-memory-prisma.js';

const RESTAURANT_ID = randomUUID();

function createHarness() {
  const db = createInMemoryPrisma();
  const hours = new OperatingHoursRepository(db.prisma);
  const specialHours = new SpecialHoursRepository(db.prisma);
  const closures = new ClosurePeriodRepository(db.prisma);
  const service = new AvailabilityService(db.prisma, hours, specialHours, closures);

  db.restaurants.push({
    id: RESTAURANT_ID,
    slug: 'spice-route',
    name: 'Spice Route',
    description: null,
    phone: null,
    email: null,
    timezone: 'Asia/Kolkata',
    status: 'ACTIVE',
    onboardingStatus: 'COMPLETED',
    orderingEnabled: true,
    avgPrepMinutes: null,
    ratingAvg: null,
    ratingCount: 0,
    submittedAt: null,
    decidedAt: null,
    rejectionReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return { db, service };
}

function addShift(
  db: InMemoryPrisma,
  dayOfWeek: number,
  opensAt: string,
  closesAt: string,
  isClosed = false,
) {
  db.operatingHours.push({
    id: randomUUID(),
    restaurantId: RESTAURANT_ID,
    dayOfWeek,
    opensAt: parseTimeOfDay(opensAt),
    closesAt: parseTimeOfDay(closesAt),
    isClosed,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

describe('AvailabilityService.isAcceptingOrders (docs/03-state-machines.md, BR-66..69)', () => {
  let harness: ReturnType<typeof createHarness>;

  beforeEach(() => {
    harness = createHarness();
  });

  it('SUSPENDED status wins regardless of hours or ordering_enabled', async () => {
    const { db, service } = harness;
    const restaurant = db.restaurants.find((r) => r.id === RESTAURANT_ID)!;
    restaurant.status = 'SUSPENDED';
    addShift(db, 6, '00:00', '23:59'); // "open all day" Saturday

    const decision = await service.isAcceptingOrders(
      RESTAURANT_ID,
      new Date('2026-01-17T06:00:00.000Z'), // Sat 11:30 IST
    );
    expect(decision).toEqual({ accepting: false, reason: 'SUSPENDED' });
  });

  it('an active closure period wins over open hours (ON_BREAK)', async () => {
    const { db, service } = harness;
    addShift(db, 6, '00:00', '23:59');
    db.closurePeriods.push({
      id: randomUUID(),
      restaurantId: RESTAURANT_ID,
      startsAt: new Date('2026-01-17T00:00:00.000Z'),
      endsAt: null,
      reason: 'Gas leak',
      createdByUserId: randomUUID(),
      createdAt: new Date(),
    });

    const decision = await service.isAcceptingOrders(
      RESTAURANT_ID,
      new Date('2026-01-17T06:00:00.000Z'),
    );
    expect(decision).toEqual({ accepting: false, reason: 'ON_BREAK' });
  });

  it('an ended closure no longer blocks (endsAt in the past)', async () => {
    const { db, service } = harness;
    addShift(db, 6, '00:00', '23:59');
    db.closurePeriods.push({
      id: randomUUID(),
      restaurantId: RESTAURANT_ID,
      startsAt: new Date('2026-01-16T00:00:00.000Z'),
      endsAt: new Date('2026-01-16T12:00:00.000Z'),
      reason: 'Past closure',
      createdByUserId: randomUUID(),
      createdAt: new Date(),
    });

    const decision = await service.isAcceptingOrders(
      RESTAURANT_ID,
      new Date('2026-01-17T06:00:00.000Z'),
    );
    expect(decision.reason).not.toBe('ON_BREAK');
  });

  it('CLOSED_NOW outside operating hours', async () => {
    const { db, service } = harness;
    addShift(db, 6, '11:00', '15:00'); // Saturday lunch only

    const decision = await service.isAcceptingOrders(
      RESTAURANT_ID,
      new Date('2026-01-17T04:00:00.000Z'), // Sat 09:30 IST — before opening
    );
    expect(decision).toEqual({ accepting: false, reason: 'CLOSED_NOW' });
  });

  it('CLOSED_NOW when no OperatingHours rows exist at all for that day', async () => {
    const { service } = harness;
    const decision = await service.isAcceptingOrders(
      RESTAURANT_ID,
      new Date('2026-01-17T06:00:00.000Z'),
    );
    expect(decision).toEqual({ accepting: false, reason: 'CLOSED_NOW' });
  });

  it('DISABLED when within hours but ordering_enabled is false', async () => {
    const { db, service } = harness;
    const restaurant = db.restaurants.find((r) => r.id === RESTAURANT_ID)!;
    restaurant.orderingEnabled = false;
    addShift(db, 6, '00:00', '23:59');

    const decision = await service.isAcceptingOrders(
      RESTAURANT_ID,
      new Date('2026-01-17T06:00:00.000Z'),
    );
    expect(decision).toEqual({ accepting: false, reason: 'DISABLED' });
  });

  it('ACCEPTING when active, no closure, within hours, and ordering_enabled', async () => {
    const { db, service } = harness;
    addShift(db, 6, '11:00', '23:00');

    const decision = await service.isAcceptingOrders(
      RESTAURANT_ID,
      new Date('2026-01-17T06:00:00.000Z'), // Sat 11:30 IST
    );
    expect(decision).toEqual({ accepting: true, reason: 'ACCEPTING' });
  });

  describe('overnight windows (closesAt <= opensAt)', () => {
    it("is open late at night on the shift's own day", async () => {
      const { db, service } = harness;
      addShift(db, 5, '22:00', '02:00'); // Friday night into Saturday morning

      // Friday 23:00 IST
      const decision = await service.isAcceptingOrders(
        RESTAURANT_ID,
        new Date('2026-01-16T17:30:00.000Z'),
      );
      expect(decision).toEqual({ accepting: true, reason: 'ACCEPTING' });
    });

    it('is still open just after midnight, spilling into the next calendar day', async () => {
      const { db, service } = harness;
      addShift(db, 5, '22:00', '02:00'); // Friday 22:00 -> Saturday 02:00

      // Saturday 01:00 IST — the day after the shift's nominal dayOfWeek
      const decision = await service.isAcceptingOrders(
        RESTAURANT_ID,
        new Date('2026-01-16T19:30:00.000Z'),
      );
      expect(decision).toEqual({ accepting: true, reason: 'ACCEPTING' });
    });

    it('is closed once the overnight window ends', async () => {
      const { db, service } = harness;
      addShift(db, 5, '22:00', '02:00');

      // Saturday 03:00 IST — past closesAt
      const decision = await service.isAcceptingOrders(
        RESTAURANT_ID,
        new Date('2026-01-16T21:30:00.000Z'),
      );
      expect(decision).toEqual({ accepting: false, reason: 'CLOSED_NOW' });
    });

    it('is closed before the overnight window opens', async () => {
      const { db, service } = harness;
      addShift(db, 5, '22:00', '02:00');

      // Friday 20:00 IST — before opensAt
      const decision = await service.isAcceptingOrders(
        RESTAURANT_ID,
        new Date('2026-01-16T14:30:00.000Z'),
      );
      expect(decision).toEqual({ accepting: false, reason: 'CLOSED_NOW' });
    });
  });

  describe('split shifts (multiple OperatingHours rows per day)', () => {
    it('is open during either shift and closed in the gap between them', async () => {
      const { db, service } = harness;
      addShift(db, 6, '11:00', '15:00'); // lunch
      addShift(db, 6, '18:00', '23:00'); // dinner

      const lunch = await service.isAcceptingOrders(
        RESTAURANT_ID,
        new Date('2026-01-17T07:00:00.000Z'), // Sat 12:30 IST
      );
      expect(lunch.accepting).toBe(true);

      const gap = await service.isAcceptingOrders(
        RESTAURANT_ID,
        new Date('2026-01-17T10:30:00.000Z'), // Sat 16:00 IST
      );
      expect(gap).toEqual({ accepting: false, reason: 'CLOSED_NOW' });

      const dinner = await service.isAcceptingOrders(
        RESTAURANT_ID,
        new Date('2026-01-17T14:00:00.000Z'), // Sat 19:30 IST
      );
      expect(dinner.accepting).toBe(true);
    });
  });

  describe('SpecialHours overrides OperatingHours entirely for that date', () => {
    it('closes a day that would otherwise be open', async () => {
      const { db, service } = harness;
      addShift(db, 6, '00:00', '23:59'); // normally open all day Saturday
      db.specialHours.push({
        id: randomUUID(),
        restaurantId: RESTAURANT_ID,
        date: new Date('2026-01-17T00:00:00.000Z'),
        isClosed: true,
        opensAt: null,
        closesAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const decision = await service.isAcceptingOrders(
        RESTAURANT_ID,
        new Date('2026-01-17T06:00:00.000Z'),
      );
      expect(decision).toEqual({ accepting: false, reason: 'CLOSED_NOW' });
    });

    it('opens a day that would otherwise be closed (extended holiday hours)', async () => {
      const { db, service } = harness;
      // No OperatingHours row for Saturday at all — normally CLOSED_NOW.
      db.specialHours.push({
        id: randomUUID(),
        restaurantId: RESTAURANT_ID,
        date: new Date('2026-01-17T00:00:00.000Z'),
        isClosed: false,
        opensAt: parseTimeOfDay('09:00'),
        closesAt: parseTimeOfDay('23:00'),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const decision = await service.isAcceptingOrders(
        RESTAURANT_ID,
        new Date('2026-01-17T06:00:00.000Z'), // Sat 11:30 IST
      );
      expect(decision).toEqual({ accepting: true, reason: 'ACCEPTING' });
    });
  });
});
