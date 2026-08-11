import { Inject, Injectable } from '@nestjs/common';
import type { Promotion, PromotionType } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreatePromotionInput {
  restaurantId: string | null;
  code: string;
  name: string;
  type: PromotionType;
  value: number;
  minOrderMinor?: bigint;
  maxDiscountMinor?: bigint;
  startsAt?: Date;
  endsAt?: Date;
  usageLimitTotal?: number;
  usageLimitPerCustomer?: number;
  firstOrderOnly?: boolean;
  createdByUserId: string;
}

export interface UpdatePromotionInput {
  name?: string;
  isActive?: boolean;
  endsAt?: Date | null;
  maxDiscountMinor?: bigint | null;
  usageLimitTotal?: number | null;
  usageLimitPerCustomer?: number | null;
}

/**
 * Non-transactional reads/writes only — the concurrency-critical path
 * (lock + count + reserve) lives in `PromotionReservationService`,
 * which talks to the transaction client directly rather than through
 * this repository, the same split `RefundService` already uses for its
 * own lock-count-insert sequence.
 */
@Injectable()
export class PromotionRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** `code` is normalised to uppercase on write (see `normalizeCode`) — lookups must match. */
  async findByActiveCode(code: string): Promise<Promotion | null> {
    return this.prisma.promotion.findFirst({
      where: { code: normalizeCode(code), isActive: true, archivedAt: null },
    });
  }

  async findById(id: string): Promise<Promotion | null> {
    return this.prisma.promotion.findUnique({ where: { id } });
  }

  async findByIdForRestaurant(id: string, restaurantId: string): Promise<Promotion | null> {
    return this.prisma.promotion.findFirst({ where: { id, restaurantId } });
  }

  async listForRestaurant(restaurantId: string): Promise<Promotion[]> {
    return this.prisma.promotion.findMany({
      where: { restaurantId, archivedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listPlatform(
    cursor?: string,
    limit = 20,
  ): Promise<{ items: Promotion[]; hasMore: boolean }> {
    const rows = await this.prisma.promotion.findMany({
      where: { archivedAt: null },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
  }

  async create(input: CreatePromotionInput): Promise<Promotion> {
    return this.prisma.promotion.create({
      data: {
        restaurantId: input.restaurantId,
        code: normalizeCode(input.code),
        name: input.name,
        type: input.type,
        value: input.value,
        minOrderMinor: input.minOrderMinor,
        maxDiscountMinor: input.maxDiscountMinor,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        usageLimitTotal: input.usageLimitTotal,
        usageLimitPerCustomer: input.usageLimitPerCustomer,
        firstOrderOnly: input.firstOrderOnly ?? false,
        createdByUserId: input.createdByUserId,
      },
    });
  }

  async update(id: string, input: UpdatePromotionInput): Promise<Promotion> {
    return this.prisma.promotion.update({ where: { id }, data: input });
  }
}

/** Coupon codes are case-insensitive by normalisation, not by a case-insensitive DB collation — "WELCOME50" and "welcome50" are the same code everywhere. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
