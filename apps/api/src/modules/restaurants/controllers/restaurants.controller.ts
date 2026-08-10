import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { Restaurant, User } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { CreateRestaurantDto } from '../dto/create-restaurant.dto.js';
import { RestaurantService } from '../services/restaurant.service.js';

/**
 * `/restaurants` (plural) — creation only, before any tenant exists.
 * Every OTHER restaurant route is `/restaurant` (singular,
 * docs/04-api-specification.md §8.1) because it resolves its tenant
 * from the caller's membership; this is the one exception, since
 * there is no membership yet for `@TenantScoped()` to resolve.
 */
@Controller('restaurants')
export class RestaurantsController {
  constructor(@Inject(RestaurantService) private readonly restaurants: RestaurantService) {}

  @Post()
  @UseGuards(AuthGuard)
  @HttpCode(201)
  async create(@CurrentUser() user: User, @Body() body: unknown) {
    const input = CreateRestaurantDto.parse(body);
    const restaurant = await this.restaurants.createRestaurant(user.id, input);
    return ok(toPublicRestaurant(restaurant));
  }
}

export function toPublicRestaurant(restaurant: Restaurant) {
  return {
    id: restaurant.id,
    slug: restaurant.slug,
    name: restaurant.name,
    description: restaurant.description,
    phone: restaurant.phone,
    email: restaurant.email,
    timezone: restaurant.timezone,
    status: restaurant.status,
    onboardingStatus: restaurant.onboardingStatus,
    orderingEnabled: restaurant.orderingEnabled,
    createdAt: restaurant.createdAt,
  };
}
