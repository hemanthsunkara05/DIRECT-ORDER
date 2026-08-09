import { Inject, Injectable } from '@nestjs/common';
import type { AuditLog, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service.js';
import { getCurrentRequestId } from '../logging/request-context.js';
import type { AuditEntryInput } from './audit.types.js';

export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * The only way any code in this application writes to `audit_logs`.
 * Deliberately exposes `record` and `find*` — nothing else. There is no
 * `update` or `delete` method on this class, and there never should be:
 * that is the first of the two enforcement layers described on the
 * AuditLog model in schema.prisma. The second is
 * `prisma/grants.sql`, which revokes UPDATE/DELETE on this table from
 * the database role the application connects as, so even a future bug
 * that reaches for `this.prisma.$executeRaw` cannot rewrite history
 * either.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Records one audited action. Fire-and-forget from the caller's
   * perspective is NOT the intended usage — callers await this inside
   * the same transaction as the state change it documents wherever
   * possible, so an audit record and the change it describes are
   * committed atomically.
   */
  async record(entry: AuditEntryInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        actorType: entry.actorType,
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        restaurantId: entry.restaurantId,
        before: toJsonInput(entry.before),
        after: toJsonInput(entry.after),
        reason: entry.reason,
        correlationId: getCurrentRequestId(),
        ipHash: entry.ipHash,
      },
    });
  }

  async findByEntity(
    entityType: string,
    entityId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<AuditLog>> {
    return this.paginate({ entityType, entityId }, options);
  }

  async findByActor(
    actorType: string,
    actorId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<AuditLog>> {
    return this.paginate({ actorType, actorId }, options);
  }

  async findByRestaurant(
    restaurantId: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<Page<AuditLog>> {
    return this.paginate({ restaurantId }, options);
  }

  private async paginate(
    where: Prisma.AuditLogWhereInput,
    options: { limit?: number; cursor?: string },
  ): Promise<Page<AuditLog>> {
    const limit = Math.min(options.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    const items = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > limit;
    return { items: hasMore ? items.slice(0, limit) : items, hasMore };
  }
}

/** Prisma's Json input type has no room for `undefined` — only `Prisma.JsonNull` or an actual value. */
function toJsonInput(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined) return undefined;
  return value as Prisma.InputJsonValue;
}
