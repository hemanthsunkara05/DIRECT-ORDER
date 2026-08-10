import { Inject, Injectable } from '@nestjs/common';
import type { OutboxEvent, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';

@Injectable()
export class OutboxRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(eventType: string, payload: unknown): Promise<OutboxEvent> {
    return this.prisma.outboxEvent.create({
      data: { eventType, payload: payload as Prisma.InputJsonValue },
    });
  }

  async findPending(limit: number): Promise<OutboxEvent[]> {
    return this.prisma.outboxEvent.findMany({
      where: { status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
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
