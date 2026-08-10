import { Inject, Injectable } from '@nestjs/common';
import type { ClosurePeriod, OperatingHours, Restaurant } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { OperatingHoursRepository } from '../repositories/operating-hours.repository.js';
import { ClosurePeriodRepository } from '../repositories/closure-period.repository.js';
import { parseTimeOfDay } from '../time-of-day.js';
import type { SetHoursInput } from '../dto/set-hours.dto.js';
import type { CreateClosureInput } from '../dto/create-closure.dto.js';

/**
 * Restaurant-facing management for the data AvailabilityService reads:
 * the weekly schedule (`/restaurant/hours`), temporary closures
 * (`/restaurant/closures`), and the `ordering_enabled` switch
 * (`/restaurant/availability`) — docs/04-api-specification.md §8.5.
 */
@Injectable()
export class RestaurantAvailabilityService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OperatingHoursRepository) private readonly hours: OperatingHoursRepository,
    @Inject(ClosurePeriodRepository) private readonly closures: ClosurePeriodRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async getHours(restaurantId: string): Promise<OperatingHours[]> {
    return this.hours.list(restaurantId);
  }

  async setHours(
    restaurantId: string,
    actorId: string,
    input: SetHoursInput,
  ): Promise<OperatingHours[]> {
    const rows = input.days.map((day) => {
      const opensAt = parseTimeOfDay(day.opensAt);
      const closesAt = parseTimeOfDay(day.closesAt);
      if (!day.isClosed && opensAt.getTime() === closesAt.getTime()) {
        throw new ValidationError('opensAt and closesAt cannot be identical for an open shift.');
      }
      return { dayOfWeek: day.dayOfWeek, opensAt, closesAt, isClosed: day.isClosed ?? false };
    });

    const created = await this.hours.replaceAll(restaurantId, rows);

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'RESTAURANT_HOURS_SET',
      entityType: 'OperatingHours',
      restaurantId,
      after: { count: created.length },
    });

    return created;
  }

  async listClosures(restaurantId: string): Promise<ClosurePeriod[]> {
    return this.closures.list(restaurantId);
  }

  async createClosure(
    restaurantId: string,
    actorId: string,
    input: CreateClosureInput,
  ): Promise<ClosurePeriod> {
    if (input.endsAt && input.endsAt.getTime() <= input.startsAt.getTime()) {
      throw new ValidationError('endsAt must be after startsAt.');
    }

    const closure = await this.closures.create(restaurantId, {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      reason: input.reason,
      createdByUserId: actorId,
    });

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'RESTAURANT_CLOSURE_CREATED',
      entityType: 'ClosurePeriod',
      entityId: closure.id,
      restaurantId,
      after: { startsAt: closure.startsAt, endsAt: closure.endsAt, reason: closure.reason },
    });

    return closure;
  }

  async endClosure(restaurantId: string, actorId: string, closureId: string): Promise<void> {
    const existing = await this.closures.findById(restaurantId, closureId);
    if (!existing) {
      throw new NotFoundError('Closure period not found.');
    }

    const now = new Date();
    const ended = await this.closures.end(restaurantId, closureId, now);
    if (!ended) {
      throw new NotFoundError('Closure period not found.');
    }

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'RESTAURANT_CLOSURE_ENDED',
      entityType: 'ClosurePeriod',
      entityId: closureId,
      restaurantId,
    });
  }

  /**
   * Toggling this alone can never make a SUSPENDED restaurant orderable
   * — `isAcceptingOrders()`'s precedence checks `Restaurant.status`
   * first, unconditionally, before this field is ever consulted
   * (docs/04-api-specification.md §8.5: "cannot override suspension").
   * No extra guard is needed here for that reason; this method simply
   * persists the switch.
   */
  async setOrderingEnabled(
    restaurantId: string,
    actorId: string,
    orderingEnabled: boolean,
  ): Promise<Restaurant> {
    const updated = await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { orderingEnabled },
    });

    await this.audit.record({
      actorType: 'RESTAURANT_USER',
      actorId,
      action: 'RESTAURANT_ORDERING_TOGGLED',
      entityType: 'Restaurant',
      entityId: restaurantId,
      restaurantId,
      after: { orderingEnabled },
    });

    return updated;
  }
}
