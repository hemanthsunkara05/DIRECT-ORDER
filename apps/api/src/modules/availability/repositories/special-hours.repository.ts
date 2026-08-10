import { Inject, Injectable } from '@nestjs/common';
import type { SpecialHours } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

/**
 * Read-only in Phase 7 — see the SpecialHours model's doc comment in
 * schema.prisma for why there is no write endpoint yet. Tests seed rows
 * directly (same pattern as seeding a RestaurantStaff row with no
 * dedicated "become staff" endpoint).
 */
@Injectable()
export class SpecialHoursRepository extends TenantScopedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  /** `dateKey` is `YYYY-MM-DD` in the restaurant's own timezone (timezone.ts's `LocalMoment.dateKey`). */
  async findByDate(restaurantId: string, dateKey: string): Promise<SpecialHours | null> {
    return this.prisma.specialHours.findFirst({
      where: this.withTenant(restaurantId, { date: new Date(`${dateKey}T00:00:00.000Z`) }),
    });
  }
}
