import { Inject, Injectable } from '@nestjs/common';
import type { RestaurantSettings } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

export interface UpsertRestaurantSettingsInput {
  minOrderAmountMinor?: bigint;
  packagingFeeMinor?: bigint;
  deliveryFeeMode?: string;
  deliveryFeeFlatMinor?: bigint;
  acceptsOnlinePayment?: boolean;
  autoAcceptOrders?: boolean;
  notificationEmails?: string[];
  notificationPhones?: string[];
}

@Injectable()
export class RestaurantSettingsRepository extends TenantScopedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async find(restaurantId: string): Promise<RestaurantSettings | null> {
    return this.prisma.restaurantSettings.findUnique({ where: { restaurantId } });
  }

  async upsert(
    restaurantId: string,
    input: UpsertRestaurantSettingsInput,
  ): Promise<RestaurantSettings> {
    return this.prisma.restaurantSettings.upsert({
      where: { restaurantId },
      create: this.withTenant(restaurantId, { ...input }),
      update: input,
    });
  }
}
