import { Inject, Injectable } from '@nestjs/common';
import type { Order, OrderStatus } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { ConflictError, NotFoundError } from '../../../platform/errors/app-error.js';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';

export type OrderActorType = 'SYSTEM' | 'CUSTOMER' | 'RESTAURANT_USER' | 'ADMIN';

export interface OrderActor {
  type: OrderActorType;
  id?: string;
}

export interface TransitionOptions {
  reason?: string;
}

export interface TransitionResult {
  order: Order;
  /** false when this call was an idempotent replay — the order was already at `toStatus`. */
  applied: boolean;
}

/**
 * The single service every Order status change goes through
 * (docs/03-state-machines.md §7: "All transitions go through a single
 * service per aggregate; no controller, worker, or admin path writes a
 * status column directly"). The FULL graph is encoded here now, even
 * though Phase 9 only ever calls `transition()` for the
 * PENDING_PAYMENT → PLACED/PAYMENT_FAILED/EXPIRED edges — see the
 * OrderStatus enum's doc comment in schema.prisma for exactly which
 * edges have no HTTP path yet and why.
 *
 * Domain-specific preconditions ("payment CAPTURED and amount matches
 * exactly", "reason required for REJECTED/CANCELLED") are split two
 * ways: the ones this service can check on its own inputs (reason
 * presence) are enforced here; the ones that need another aggregate's
 * state (payment status) are the caller's responsibility — the caller
 * (PaymentVerificationService, WebhookService, the expiry scheduler)
 * confirms its own precondition BEFORE calling `transition()`, so this
 * service stays focused on graph legality, locking, and history,
 * exactly the "one service per aggregate" boundary the docs draw.
 */
@Injectable()
export class OrderStateService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  async transition(
    orderId: string,
    toStatus: OrderStatus,
    actor: OrderActor,
    options: TransitionOptions = {},
  ): Promise<TransitionResult> {
    if (requiresReason(toStatus) && !options.reason) {
      throw new ConflictError(`A reason is required to move an order to ${toStatus}.`);
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Universal rule 2 (docs/03 §7): lock before reading current
      // state. Real Postgres would do this via `SELECT ... FOR UPDATE`;
      // see OrderRepository.findByIdForUpdate's doc comment for why
      // this degrades to a plain read in this sandbox.
      const current = await tx.order.findUnique({ where: { id: orderId } });
      if (!current) {
        throw new NotFoundError('Order not found.');
      }

      if (current.status === toStatus) {
        // Rule 6: idempotent replay, not a 409 — "already in target
        // state" is distinct from "cannot reach target state".
        return { order: current, applied: false };
      }

      const fromStatus = current.status;
      const allowedTargets = ORDER_TRANSITIONS[fromStatus];
      if (!allowedTargets.includes(toStatus)) {
        throw new ConflictError(`Order ${orderId} cannot move from ${fromStatus} to ${toStatus}.`, [
          { field: 'status', message: `Current state is ${fromStatus}.` },
        ]);
      }

      const updated = await tx.order.update({
        where: { id: orderId },
        data: { status: toStatus, ...timestampPatch(toStatus, options.reason) },
      });

      // `fromStatus` was captured before the update above rather than
      // read off `current` again here — `current` and `updated` may be
      // the very same row (as they are, e.g., under this test suite's
      // in-memory Prisma fake, which mutates rows in place rather than
      // returning copies the way real Prisma does), so reading
      // `current.status` at this point could already reflect the new
      // value instead of the old one.
      await tx.orderStatusHistory.create({
        data: {
          orderId,
          fromStatus,
          toStatus,
          actorType: actor.type,
          actorId: actor.id,
          reason: options.reason,
        },
      });

      return { order: updated, applied: true };
    });

    if (result.applied) {
      // Universal rule 4: side effects emitted after commit, never
      // inside the transaction. A lightweight in-process outbox insert
      // (see platform/outbox) — real notification delivery arrives with
      // apps/worker's Phase 12 consumers.
      await this.outbox.record(`ORDER_${result.order.status}`, {
        orderId: result.order.id,
        orderNumber: result.order.orderNumber,
        fromStatus: null,
        toStatus: result.order.status,
      });
    }

    return result;
  }
}

function requiresReason(toStatus: OrderStatus): boolean {
  return toStatus === 'REJECTED' || toStatus === 'CANCELLED';
}

interface TimestampPatch {
  placedAt?: Date;
  acceptedAt?: Date;
  readyAt?: Date;
  deliveredAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;
  rejectionReason?: string;
}

function timestampPatch(toStatus: OrderStatus, reason?: string): TimestampPatch {
  switch (toStatus) {
    case 'PLACED':
      return { placedAt: new Date() };
    case 'ACCEPTED':
      return { acceptedAt: new Date() };
    case 'READY_FOR_PICKUP':
      return { readyAt: new Date() };
    case 'DELIVERED':
      return { deliveredAt: new Date() };
    case 'CANCELLED':
      return { cancelledAt: new Date(), cancellationReason: reason };
    case 'REJECTED':
      return { rejectionReason: reason };
    default:
      return {};
  }
}

/**
 * The full graph, docs/03-state-machines.md §7.1. Terminal states map
 * to an empty array — "Explicitly forbidden: DELIVERED/CANCELLED/
 * REJECTED/EXPIRED → *", no backwards moves, PLACED cannot skip to
 * PREPARING, ACCEPTED cannot skip to READY_FOR_PICKUP.
 */
const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ['PLACED', 'PAYMENT_FAILED', 'EXPIRED'],
  PAYMENT_FAILED: ['PENDING_PAYMENT', 'EXPIRED'],
  PLACED: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY_FOR_PICKUP', 'CANCELLED'],
  READY_FOR_PICKUP: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERY_FAILED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  DELIVERED: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
};
