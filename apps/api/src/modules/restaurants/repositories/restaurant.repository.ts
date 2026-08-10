import { Inject, Injectable } from '@nestjs/common';
import type { Prisma, Restaurant } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreateRestaurantInput {
  slug: string;
  name: string;
  description?: string;
  phone?: string;
  email?: string;
  timezone?: string;
}

/**
 * Restaurant is the tenant root itself — there is no "other" restaurant
 * to scope against, so unlike every other repository in this module,
 * this one is plain, not a TenantScopedRepository. `findBySlug` in
 * particular must stay unscoped: it's how a slug's uniqueness is
 * checked in the first place, before any restaurant (and therefore any
 * tenant context) exists yet.
 */
@Injectable()
export class RestaurantRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateRestaurantInput): Promise<Restaurant> {
    return this.prisma.restaurant.create({ data: input });
  }

  async findById(id: string): Promise<Restaurant | null> {
    return this.prisma.restaurant.findUnique({ where: { id } });
  }

  async findBySlug(slug: string): Promise<Restaurant | null> {
    return this.prisma.restaurant.findUnique({ where: { slug } });
  }

  async slugExists(slug: string): Promise<boolean> {
    const count = await this.prisma.restaurant.count({ where: { slug } });
    return count > 0;
  }

  async update(id: string, data: Prisma.RestaurantUpdateInput): Promise<Restaurant> {
    return this.prisma.restaurant.update({ where: { id }, data });
  }
}
