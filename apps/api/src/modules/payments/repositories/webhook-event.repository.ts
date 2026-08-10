import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, WebhookEvent, WebhookEventStatus } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { isUniqueConstraintViolation } from '../../../platform/database/prisma-errors.js';

export interface CreateWebhookEventInput {
  provider: string;
  providerEventId: string;
  eventType: string;
  signatureValid: boolean;
  payload: unknown;
}

@Injectable()
export class WebhookEventRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * The idempotency anchor (docs/02-database-schema.md §6.3): a unique
   * `(provider, providerEventId)` violation means this exact event was
   * already stored — the caller must treat that as "duplicate, return
   * 200, stop" (BR-39, BR-40), never retry the insert.
   */
  async createIfNotExists(input: CreateWebhookEventInput): Promise<WebhookEvent | null> {
    try {
      return await this.prisma.webhookEvent.create({
        data: {
          provider: input.provider,
          providerEventId: input.providerEventId,
          eventType: input.eventType,
          signatureValid: input.signatureValid,
          payload: input.payload as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  async markProcessed(id: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { status: 'FAILED', lastError: error, attempts: { increment: 1 } },
    });
  }

  async markIgnored(id: string, reason: string): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id },
      data: { status: 'IGNORED', lastError: reason, processedAt: new Date() },
    });
  }

  async findByStatus(status: WebhookEventStatus, limit = 50): Promise<WebhookEvent[]> {
    return this.prisma.webhookEvent.findMany({
      where: { status },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    });
  }
}
