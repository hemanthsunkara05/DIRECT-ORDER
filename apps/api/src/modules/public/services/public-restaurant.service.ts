import { Inject, Injectable } from '@nestjs/common';
import type { MenuCategory, MenuItem, OperatingHours } from '@prisma/client';
import { NotFoundError } from '../../../platform/errors/app-error.js';
import {
  AvailabilityService,
  type AvailabilityDecision,
} from '../../availability/availability.service.js';
import { OperatingHoursRepository } from '../../availability/repositories/operating-hours.repository.js';
import {
  PublicRestaurantRepository,
  type RestaurantWithPublicRelations,
} from '../repositories/public-restaurant.repository.js';
import { PublicMenuRepository } from '../repositories/public-menu.repository.js';

export interface PublicProfile {
  restaurant: RestaurantWithPublicRelations;
  availability: AvailabilityDecision;
  hours: OperatingHours[];
}

export interface PublicMenu {
  categories: MenuCategory[];
  items: MenuItem[];
}

/**
 * The one place that decides whether a restaurant is visible to the
 * public at all (docs/03-state-machines.md's public-page state table):
 * DRAFT/PENDING_APPROVAL restaurants — never published — 404, exactly
 * like a slug that doesn't exist at all (no distinction is leaked
 * between "never existed" and "not published yet"). ACTIVE, SUSPENDED,
 * and CLOSED are all visible (200) — SUSPENDED/CLOSED render with a
 * non-accepting `availability` decision instead of disappearing, so an
 * existing customer with a bookmarked link still gets an explanation
 * rather than a bare 404.
 */
@Injectable()
export class PublicRestaurantService {
  constructor(
    @Inject(PublicRestaurantRepository) private readonly restaurants: PublicRestaurantRepository,
    @Inject(PublicMenuRepository) private readonly menu: PublicMenuRepository,
    @Inject(OperatingHoursRepository) private readonly hours: OperatingHoursRepository,
    @Inject(AvailabilityService) private readonly availability: AvailabilityService,
  ) {}

  async getProfile(slug: string): Promise<PublicProfile> {
    const restaurant = await this.findVisibleBySlug(slug);
    const [decision, hours] = await Promise.all([
      this.availability.isAcceptingOrders(restaurant.id),
      this.hours.list(restaurant.id),
    ]);
    return { restaurant, availability: decision, hours };
  }

  async getMenu(slug: string): Promise<PublicMenu> {
    const restaurant = await this.findVisibleBySlug(slug);
    const [categories, items] = await Promise.all([
      this.menu.listCategories(restaurant.id),
      this.menu.listItems(restaurant.id),
    ]);
    return { categories, items };
  }

  private async findVisibleBySlug(slug: string): Promise<RestaurantWithPublicRelations> {
    const restaurant = await this.restaurants.findBySlug(slug);
    if (!restaurant || restaurant.status === 'DRAFT' || restaurant.status === 'PENDING_APPROVAL') {
      throw new NotFoundError('Restaurant not found.');
    }
    return restaurant;
  }
}
