import { Inject, Injectable } from '@nestjs/common';
import type { OutboxEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class OutboxRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(eventType: string, payload: unknown, restaurantId?: string): Promise<OutboxEvent> {
    return this.prisma.outboxEvent.create({
      data: { eventType, payload: payload as Prisma.InputJsonValue, restaurantId },
    });
  }

  async findPending(limit: number): Promise<OutboxEvent[]> {
    return this.prisma.outboxEvent.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  /**
   * Phase 10's SSE replay/poll query: every event for one restaurant
   * with `id` (UUIDv7, time-ordered) after `afterId` — the same
   * id-as-cursor convention AuditService's pagination already
   * established. `afterId` omitted means "from the beginning of this
   * connection", not "from the beginning of time" — see
   * OrderStreamService for how the caller decides which it means.
   */
  async findSinceForRestaurant(
    restaurantId: string,
    afterId: string | undefined,
    limit: number,
  ): Promise<OutboxEvent[]> {
    return this.prisma.outboxEvent.findMany({
      where: { restaurantId, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: 'asc' },
      take: limit,
    });
  }

  async markProcessed(id: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.outboxEvent.update({
      where: { id },
      data: { status: 'FAILED', lastError: error, attempts: { increment: 1 } },
    });
  }
}
