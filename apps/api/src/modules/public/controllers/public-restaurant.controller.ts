import { Controller, Get, HttpCode, Inject, Param } from '@nestjs/common';
import type { MenuCategory, MenuItem, OperatingHours } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import type { AvailabilityDecision } from '../../availability/availability.service.js';
import { formatTimeOfDay } from '../../availability/time-of-day.js';
import { PublicRestaurantService } from '../services/public-restaurant.service.js';
import type { RestaurantWithPublicRelations } from '../repositories/public-restaurant.repository.js';

/**
 * `/public/restaurants/*` — unauthenticated (docs/04-api-specification.md
 * §8.3). No `AuthGuard`/`AuthorizationGuard`, no `X-Restaurant-Id` — the
 * slug in the URL is the entire lookup key. `CsrfGuard` is a no-op here
 * regardless (both routes are GET, and it only checks non-GET methods).
 *
 * `toPublicRestaurant`/`toPublicMenu*` are explicit field allowlists, not
 * a spread of the Prisma row — this is the highest-risk leak surface in
 * the whole API (docs/04-api-specification.md §8.3: "Explicitly
 * excluded: staff, internal user IDs, settings beyond public ones,
 * payment configuration, provider credentials, financial aggregates,
 * audit data, other customers' data, unpublished/archived menu items").
 */
@Controller('public/restaurants')
export class PublicRestaurantController {
  constructor(@Inject(PublicRestaurantService) private readonly service: PublicRestaurantService) {}

  @Get(':slug')
  @HttpCode(200)
  async getProfile(@Param('slug') slug: string) {
    const { restaurant, availability, hours } = await this.service.getProfile(slug);
    return ok(toPublicRestaurant(restaurant, availability, hours));
  }

  @Get(':slug/menu')
  @HttpCode(200)
  async getMenu(@Param('slug') slug: string) {
    const { categories, items } = await this.service.getMenu(slug);
    return ok({
      categories: categories.map((category) => ({
        ...toPublicCategory(category),
        items: items.filter((item) => item.categoryId === category.id).map(toPublicItem),
      })),
    });
  }
}

function toPublicRestaurant(
  restaurant: RestaurantWithPublicRelations,
  availability: AvailabilityDecision,
  hours: OperatingHours[],
) {
  return {
    slug: restaurant.slug,
    name: restaurant.name,
    description: restaurant.description,
    timezone: restaurant.timezone,
    // ACTIVE | SUSPENDED | CLOSED only — DRAFT/PENDING_APPROVAL already 404'd in the service.
    status: restaurant.status,
    avgPrepMinutes: restaurant.avgPrepMinutes,
    ratingAvg: restaurant.ratingAvg,
    ratingCount: restaurant.ratingCount,
    availability: { accepting: availability.accepting, reason: availability.reason },
    address: restaurant.address
      ? {
          line1: restaurant.address.line1,
          line2: restaurant.address.line2,
          locality: restaurant.address.locality,
          city: restaurant.address.city,
          state: restaurant.address.state,
          postalCode: restaurant.address.postalCode,
          latitude: restaurant.address.latitude,
          longitude: restaurant.address.longitude,
          landmark: restaurant.address.landmark,
        }
      : null,
    branding: restaurant.branding
      ? {
          logoUrl: restaurant.branding.logoUrl,
          coverImageUrl: restaurant.branding.coverImageUrl,
          themePrimaryColor: restaurant.branding.themePrimaryColor,
          themeAccentColor: restaurant.branding.themeAccentColor,
          tagline: restaurant.branding.tagline,
        }
      : null,
    // Only the settings fields that affect what a customer sees or pays.
    // autoAcceptOrders/notificationEmails/notificationPhones are internal
    // ops config and never appear here.
    settings: restaurant.settings
      ? {
          minOrderAmountMinor: restaurant.settings.minOrderAmountMinor.toString(),
          packagingFeeMinor: restaurant.settings.packagingFeeMinor.toString(),
          deliveryFeeMode: restaurant.settings.deliveryFeeMode,
          deliveryFeeFlatMinor: restaurant.settings.deliveryFeeFlatMinor.toString(),
          acceptsOnlinePayment: restaurant.settings.acceptsOnlinePayment,
        }
      : null,
    hours: hours.map((row) => ({
      dayOfWeek: row.dayOfWeek,
      opensAt: formatTimeOfDay(row.opensAt),
      closesAt: formatTimeOfDay(row.closesAt),
      isClosed: row.isClosed,
    })),
  };
}

function toPublicCategory(category: MenuCategory) {
  return {
    id: category.id,
    name: category.name,
    description: category.description,
    displayOrder: category.displayOrder,
  };
}

function toPublicItem(item: MenuItem) {
  return {
    id: item.id,
    categoryId: item.categoryId,
    name: item.name,
    description: item.description,
    priceMinor: item.priceMinor.toString(),
    currency: item.currency,
    imageUrl: item.imageUrl,
    isAvailable: item.isAvailable,
    dietaryTag: item.dietaryTag,
    displayOrder: item.displayOrder,
  };
}
