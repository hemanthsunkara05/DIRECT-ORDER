import { Inject, Injectable } from '@nestjs/common';
import type { RestaurantBranding } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

export interface UpsertRestaurantBrandingInput {
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  themePrimaryColor?: string | null;
  themeAccentColor?: string | null;
  tagline?: string | null;
}

@Injectable()
export class RestaurantBrandingRepository extends TenantScopedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async find(restaurantId: string): Promise<RestaurantBranding | null> {
    return this.prisma.restaurantBranding.findUnique({ where: { restaurantId } });
  }

  async upsert(
    restaurantId: string,
    input: UpsertRestaurantBrandingInput,
  ): Promise<RestaurantBranding> {
    return this.prisma.restaurantBranding.upsert({
      where: { restaurantId },
      create: this.withTenant(restaurantId, { ...input }),
      update: input,
    });
  }
}
