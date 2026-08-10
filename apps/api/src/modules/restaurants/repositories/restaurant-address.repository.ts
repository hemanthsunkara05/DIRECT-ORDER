import { Inject, Injectable } from '@nestjs/common';
import type { RestaurantAddress } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { TenantScopedRepository } from '../../../platform/tenancy/tenant-scoped.repository.js';

export interface UpsertRestaurantAddressInput {
  line1: string;
  line2?: string;
  locality?: string;
  city: string;
  state: string;
  postalCode: string;
  latitude?: number;
  longitude?: number;
  landmark?: string;
}

@Injectable()
export class RestaurantAddressRepository extends TenantScopedRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {
    super();
  }

  async find(restaurantId: string): Promise<RestaurantAddress | null> {
    return this.prisma.restaurantAddress.findUnique({ where: { restaurantId } });
  }

  /** Profile setup is create-or-replace, not incremental PATCH — the owner re-submits the whole address each time. */
  async upsert(
    restaurantId: string,
    input: UpsertRestaurantAddressInput,
  ): Promise<RestaurantAddress> {
    return this.prisma.restaurantAddress.upsert({
      where: { restaurantId },
      create: this.withTenant(restaurantId, { ...input }),
      update: input,
    });
  }
}
