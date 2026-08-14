import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { OutboxEvent } from '@prisma/client';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';
import { AnalyticsEventRepository } from '../repositories/analytics-event.repository.js';

/**
 * "Analytics event ingest" (docs/13-implementation-phases.md Phase 17)
 * — mirrors the ENTIRE outbox stream into `analytics_events`, not a
 * manually curated allowlist of event types. This is deliberate: every
 * domain event already carries `orderId`/`restaurantId`/etc in its
 * payload where relevant, and a hand-picked subset would silently go
 * stale the moment a future phase adds a new event type nobody
 * remembers to also add here. Idempotent via `idempotencyKey =
 * event.id` (the outbox event's own id) — a re-relayed event (this
 * codebase's outbox is "at least once," never "exactly once") produces
 * the identical `AnalyticsEvent.idempotencyKey` and collides on the
 * unique constraint, the same insert-and-let-the-constraint-decide
 * pattern every other consumer in this codebase already uses.
 *
 * Read-only with respect to every transactional table — this consumer
 * INSERTS into `analytics_events` and touches nothing else, which is
 * what makes "analytics never mutates transactional data" true by
 * construction rather than by convention.
 */
@Injectable()
export class AnalyticsOutboxConsumer implements OnModuleInit {
  constructor(
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(AnalyticsEventRepository) private readonly events: AnalyticsEventRepository,
  ) {}

  onModuleInit(): void {
    this.outbox.registerConsumer((event) => this.handle(event));
  }

  async handle(event: OutboxEvent): Promise<void> {
    const payload = (event.payload ?? {}) as {
      orderId?: string;
      restaurantId?: string;
      customerId?: string;
    };
    await this.events.create({
      type: event.eventType,
      occurredAt: event.createdAt,
      restaurantId: payload.restaurantId ?? event.restaurantId ?? undefined,
      orderId: payload.orderId,
      customerId: payload.customerId,
      properties: event.payload,
      idempotencyKey: event.id,
    });
  }
}
