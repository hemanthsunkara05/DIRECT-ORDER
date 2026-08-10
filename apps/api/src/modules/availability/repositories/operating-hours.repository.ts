import { Inject, Injectable } from '@nestjs/common';
import type { OperatingHours } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

export interface OperatingHoursRow {
  dayOfWeek: number;
  opensAt: Date;
  closesAt: Date;
  isClosed: boolean;
}

@Injectable()
export class OperatingHoursRepository extends TenantScopedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async list(restaurantId: string): Promise<OperatingHours[]> {
    return this.prisma.operatingHours.findMany({
      where: this.withTenant(restaurantId, {}),
      orderBy: [{ dayOfWeek: 'asc' }, { opensAt: 'asc' }],
    });
  }

  async listForDay(restaurantId: string, dayOfWeek: number): Promise<OperatingHours[]> {
    return this.prisma.operatingHours.findMany({
      where: this.withTenant(restaurantId, { dayOfWeek }),
    });
  }

  /**
   * `PUT /restaurant/hours` is a full replace — delete every existing
   * row for this tenant and insert the new set inside one transaction,
   * the same validate-then-write-atomically shape as Phase 6's menu
   * reorder. There is no meaningful "partial" weekly schedule, so a
   * merge/diff API would only add complexity for no real benefit.
   */
  async replaceAll(restaurantId: string, rows: OperatingHoursRow[]): Promise<OperatingHours[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.operatingHours.deleteMany({ where: { restaurantId } });
      const created: OperatingHours[] = [];
      for (const row of rows) {
        created.push(
          await tx.operatingHours.create({
            data: { restaurantId, ...row },
          }),
        );
      }
      return created;
    });
  }
}
