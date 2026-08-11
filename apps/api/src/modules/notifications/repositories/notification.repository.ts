import { Inject, Injectable } from '@nestjs/common';
import type {
  Notification,
  NotificationCategory,
  NotificationChannel,
  NotificationRecipientType,
  NotificationStatus,
} from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { isUniqueConstraintViolation } from '../../../platform/database/prisma-errors.js';

export interface CreateNotificationInput {
  outboxEventId: string;
  type: string;
  category: NotificationCategory;
  recipientType: NotificationRecipientType;
  recipientId: string;
  channel: NotificationChannel;
  title: string;
  body: string;
  contactAddress?: string | null;
  status?: NotificationStatus;
}

/**
 * `createIfNotExists` mirrors `WebhookEventRepository`/`DeliveryRepository`'s
 * P2002-catch-and-return-null shape — `@@unique([outboxEventId,
 * recipientType, recipientId, channel])` is THE guarantee against a
 * duplicate send (docs/14.1), not an existence check this repository
 * would otherwise have to run first (and race against).
 */
@Injectable()
export class NotificationRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createIfNotExists(input: CreateNotificationInput): Promise<Notification | null> {
    try {
      return await this.prisma.notification.create({
        data: {
          outboxEventId: input.outboxEventId,
          type: input.type,
          category: input.category,
          recipientType: input.recipientType,
          recipientId: input.recipientId,
          channel: input.channel,
          title: input.title,
          body: input.body,
          contactAddress: input.contactAddress ?? null,
          status: input.status ?? 'PENDING',
        },
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  async findById(id: string): Promise<Notification | null> {
    return this.prisma.notification.findUnique({ where: { id } });
  }

  async update(
    id: string,
    data: Partial<{
      status: NotificationStatus;
      readAt: Date;
      attempts: { increment: number };
      nextAttemptAt: Date | null;
      lastError: string | null;
      providerMessageId: string;
      sentAt: Date;
    }>,
  ): Promise<Notification> {
    return this.prisma.notification.update({ where: { id }, data });
  }

  /** Retryable rows for `NotificationRetryScheduler` — PENDING/FAILED, due, under the attempt cap. `maxAttempts` is applied in the caller (see that scheduler's own doc comment for why). */
  async findRetryable(now: Date, limit = 50): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }

  async findDeadLettered(limit = 50): Promise<Notification[]> {
    return this.prisma.notification.findMany({
      where: { status: 'DEAD_LETTERED' },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });
  }

  /** Notification centre list (`GET /me/notifications`) — cursor-paginated, always tenant/recipient-scoped by the caller. */
  async listForRecipient(
    recipientType: NotificationRecipientType,
    recipientId: string,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<Notification[]> {
    const limit = Math.min(options.limit ?? 20, 100);
    return this.prisma.notification.findMany({
      where: { recipientType, recipientId, channel: 'IN_APP' },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });
  }

  async countUnread(
    recipientType: NotificationRecipientType,
    recipientId: string,
  ): Promise<number> {
    return this.prisma.notification.count({
      where: { recipientType, recipientId, channel: 'IN_APP', readAt: null },
    });
  }

  /** `findFirst`, not `findUnique` — `{id, recipientType, recipientId}` isn't a declared unique constraint, only `id` alone is; the extra filters are the ownership check itself. */
  async findByIdForRecipient(
    id: string,
    recipientType: NotificationRecipientType,
    recipientId: string,
  ): Promise<Notification | null> {
    return this.prisma.notification.findFirst({ where: { id, recipientType, recipientId } });
  }

  async markRead(id: string): Promise<void> {
    await this.prisma.notification.update({ where: { id }, data: { readAt: new Date() } });
  }

  async markAllRead(
    recipientType: NotificationRecipientType,
    recipientId: string,
  ): Promise<number> {
    const result = await this.prisma.notification.updateMany({
      where: { recipientType, recipientId, channel: 'IN_APP', readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }
}
