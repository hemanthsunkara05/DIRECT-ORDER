import { Inject, Injectable } from '@nestjs/common';
import type { Restaurant, RestaurantStatus } from '@prisma/client';
import { ConflictError, NotFoundError } from '../../../platform/errors/app-error.js';
import { AuditService } from '../../../platform/audit/audit.service.js';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';

/**
 * The admin-driven edges of docs/03-state-machines.md §7.5's restaurant
 * lifecycle that have an endpoint (docs/04-api-specification.md §8.7:
 * approve/suspend/reinstate/reject, Phase 21a) — `DRAFT →
 * PENDING_APPROVAL` (owner's own onboarding submit, Phase 5) and
 * `ACTIVE → CLOSED` have no admin API surface in the spec, so they are
 * not built here (same "only wire what's reachable" principle every
 * prior phase has applied).
 */
const ADMIN_TRANSITIONS: Partial<Record<RestaurantStatus, RestaurantStatus[]>> = {
  PENDING_APPROVAL: ['ACTIVE', 'REJECTED'],
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
 *
 * `transition()` locks the row with a real `SELECT ... FOR UPDATE`
 * inside a transaction (Phase 21a) — found via `/plan-eng-review`'s
 * outside-voice pass: a bare `prisma.$transaction` wrap around a plain
 * `update(id, {status})` does NOT stop a concurrent transaction from
 * reading stale status and blind-writing over it, since `update` has no
 * `WHERE status = expectedStatus` guard. Mirrors
 * `promotion-reservation.service.ts`'s exact idiom (`tx.$queryRaw` +
 * `FOR UPDATE`, `::uuid`-cast since `id` is a UUID column — see
 * `loyalty-account.repository.ts`'s own doc comment on why the cast is
 * required against real Postgres).
 */
@Injectable()
export class RestaurantStateService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async transition(
    restaurantId: string,
    toStatus: RestaurantStatus,
    adminUserId: string,
    reason?: string,
  ): Promise<Restaurant> {
    const result = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM restaurants WHERE id = ${restaurantId}::uuid FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundError('Restaurant not found.');
      }
      const current = await tx.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
      // Captured as a primitive right away, never re-read off `current`
      // below — `tx.restaurant.update()` returns the row Prisma just
      // wrote, and against this fake's in-memory store that's the SAME
      // object reference `current` already points to, so reading
      // `current.status` again after `update()` would silently observe
      // the post-transition value instead of the pre-transition one.
      const fromStatus = current.status;

      const allowed = ADMIN_TRANSITIONS[fromStatus] ?? [];
      if (!allowed.includes(toStatus)) {
        throw new ConflictError(
          `Restaurant ${restaurantId} cannot move from ${fromStatus} to ${toStatus}.`,
          [{ field: 'status', message: `Current state is ${fromStatus}.` }],
        );
      }

      // `decidedAt`/`rejectionReason` record the decision on a PENDING_APPROVAL
      // submission specifically — not `reinstate()`'s SUSPENDED -> ACTIVE, which
      // is a different kind of decision and must not overwrite the original
      // approval's `decidedAt`.
      const decisionFields =
        fromStatus === 'PENDING_APPROVAL'
          ? { decidedAt: new Date(), rejectionReason: toStatus === 'REJECTED' ? reason : null }
          : {};

      const updated = await tx.restaurant.update({
        where: { id: restaurantId },
        data: { status: toStatus, ...decisionFields },
      });

      await this.audit.record({
        actorType: 'ADMIN',
        actorId: adminUserId,
        action: `RESTAURANT_${toStatus}`,
        entityType: 'Restaurant',
        entityId: restaurantId,
        restaurantId,
        before: { status: fromStatus },
        after: { status: toStatus },
        reason,
      });

      return { restaurant: updated, fromStatus };
    });

    // Side effects after commit, never inside the transaction
    // (docs/03-state-machines.md universal rule 4). Gated on `fromStatus`,
    // not just the resulting status — `reinstate()` also lands on ACTIVE
    // (from SUSPENDED) and must not fire an approval notification.
    if (result.fromStatus === 'PENDING_APPROVAL' && result.restaurant.status === 'ACTIVE') {
      await this.outbox.record(
        'RESTAURANT_APPROVED',
        { restaurantId: result.restaurant.id },
        result.restaurant.id,
      );
    } else if (result.restaurant.status === 'REJECTED') {
      await this.outbox.record(
        'RESTAURANT_REJECTED',
        { restaurantId: result.restaurant.id, reason: result.restaurant.rejectionReason },
        result.restaurant.id,
      );
    }

    return result.restaurant;
  }

  async approve(restaurantId: string, adminUserId: string): Promise<Restaurant> {
    return this.transition(restaurantId, 'ACTIVE', adminUserId);
  }

  async reject(restaurantId: string, adminUserId: string, reason: string): Promise<Restaurant> {
    return this.transition(restaurantId, 'REJECTED', adminUserId, reason);
  }

  async suspend(restaurantId: string, adminUserId: string, reason: string): Promise<Restaurant> {
    return this.transition(restaurantId, 'SUSPENDED', adminUserId, reason);
  }

  async reinstate(restaurantId: string, adminUserId: string): Promise<Restaurant> {
    return this.transition(restaurantId, 'ACTIVE', adminUserId);
  }
}
