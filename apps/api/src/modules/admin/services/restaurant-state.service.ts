import { Inject, Injectable } from '@nestjs/common';
import type { Restaurant, RestaurantStatus } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../../platform/errors/app-error.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { RestaurantRepository } from '../../restaurants/repositories/restaurant.repository.js';

/**
 * The three admin-driven edges of docs/03-state-machines.md §7.5's
 * restaurant lifecycle that actually have an endpoint
 * (docs/04-api-specification.md §8.7: approve/suspend/reinstate) —
 * `DRAFT → PENDING_APPROVAL` (owner's own onboarding submit, Phase 5),
 * `PENDING_APPROVAL → REJECTED`, `ACTIVE → CLOSED`, and
 * `REJECTED → PENDING_APPROVAL` have no admin API surface in the spec,
 * so they are not built here (same "only wire what's reachable"
 * principle every prior phase has applied).
 */
const ADMIN_TRANSITIONS: Partial<Record<RestaurantStatus, RestaurantStatus[]>> = {
  PENDING_APPROVAL: ['ACTIVE'],
  ACTIVE: ['SUSPENDED'],
  SUSPENDED: ['ACTIVE'],
};

/**
 * Deliberately does NOT touch orders, payments, or deliveries —
 * docs/03 §7.5: "Suspension does not cancel or refund existing orders.
 * Orders in flight complete normally; only new order creation is
 * blocked." That blocking is already structural: `isAcceptingOrders()`
 * (Phase 7's one-authoritative-function, `AvailabilityService`) already
 * checks `restaurant.status !== 'ACTIVE'` — flipping the status column
 * here is the entire mechanism, nothing else needs to change for a
 * SUSPENDED restaurant to stop accepting new orders while staff retain
 * full read/manage access to orders already placed.
 */
@Injectable()
export class RestaurantStateService {
  constructor(
    @Inject(RestaurantRepository) private readonly restaurants: RestaurantRepository,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async transition(
    restaurantId: string,
    toStatus: RestaurantStatus,
    adminUserId: string,
    reason?: string,
  ): Promise<Restaurant> {
    const current = await this.restaurants.findById(restaurantId);
    if (!current) {
      throw new NotFoundError('Restaurant not found.');
    }

    const allowed = ADMIN_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(toStatus)) {
      throw new ConflictError(
        `Restaurant ${restaurantId} cannot move from ${current.status} to ${toStatus}.`,
        [{ field: 'status', message: `Current state is ${current.status}.` }],
      );
    }

    const updated = await this.restaurants.update(restaurantId, { status: toStatus });

    await this.audit.record({
      actorType: 'ADMIN',
      actorId: adminUserId,
      action: `RESTAURANT_${toStatus}`,
      entityType: 'Restaurant',
      entityId: restaurantId,
      restaurantId,
      before: { status: current.status },
      after: { status: toStatus },
      reason,
    });

    return updated;
  }

  async approve(restaurantId: string, adminUserId: string): Promise<Restaurant> {
    return this.transition(restaurantId, 'ACTIVE', adminUserId);
  }

  async suspend(restaurantId: string, adminUserId: string, reason: string): Promise<Restaurant> {
    return this.transition(restaurantId, 'SUSPENDED', adminUserId, reason);
  }

  async reinstate(restaurantId: string, adminUserId: string): Promise<Restaurant> {
    return this.transition(restaurantId, 'ACTIVE', adminUserId);
  }
}
