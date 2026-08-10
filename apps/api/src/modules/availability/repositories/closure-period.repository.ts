import { Inject, Injectable } from '@nestjs/common';
import type { ClosurePeriod } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

export interface CreateClosurePeriodInput {
  startsAt: Date;
  endsAt?: Date | null;
  reason?: string;
  createdByUserId: string;
}

@Injectable()
export class ClosurePeriodRepository extends TenantScopedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async create(restaurantId: string, input: CreateClosurePeriodInput): Promise<ClosurePeriod> {
    return this.prisma.closurePeriod.create({
      data: this.withTenant(restaurantId, {
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        reason: input.reason,
        createdByUserId: input.createdByUserId,
      }),
    });
  }

  async findById(restaurantId: string, closureId: string): Promise<ClosurePeriod | null> {
    return this.prisma.closurePeriod.findFirst({
      where: this.withTenant(restaurantId, { id: closureId }),
    });
  }

  async list(restaurantId: string): Promise<ClosurePeriod[]> {
    return this.prisma.closurePeriod.findMany({
      where: this.withTenant(restaurantId, {}),
      orderBy: { startsAt: 'desc' },
    });
  }

  /** The one currently-in-effect closure, if any: `startsAt <= at` and (`endsAt` is null or still in the future). */
  async findActive(restaurantId: string, at: Date): Promise<ClosurePeriod | null> {
    return this.prisma.closurePeriod.findFirst({
      where: this.withTenant(restaurantId, {
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
      }),
    });
  }

  /** Ends a closure early — sets `endsAt` rather than deleting the row, so it stays in history. */
  async end(restaurantId: string, closureId: string, endsAt: Date): Promise<boolean> {
    const result = await this.prisma.closurePeriod.updateMany({
      where: this.withTenant(restaurantId, { id: closureId }),
      data: { endsAt },
    });
    return result.count > 0;
  }
}
