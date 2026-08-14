import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { isUniqueConstraintViolation } from '../../../platform/database/prisma-errors.js';

export interface CreateAnalyticsEventInput {
  type: string;
  occurredAt: Date;
  sessionId?: string;
  customerId?: string;
  restaurantId?: string;
  orderId?: string;
  properties?: unknown;
  idempotencyKey?: string;
}

/**
 * docs/01-domain-model.md §5.14: "append-only... never used as a
 * transactional source of truth." `create` is the only write method —
 * insert-and-let-the-constraint-decide on `idempotencyKey` for events
 * that carry one (a re-relayed outbox event), matching every other
 * consumer in this codebase.
 */
@Injectable()
export class AnalyticsEventRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateAnalyticsEventInput): Promise<void> {
    try {
      await this.prisma.analyticsEvent.create({
        data: { ...input, properties: input.properties as object | undefined },
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return; // already ingested this exact event.
      throw error;
    }
  }
}
