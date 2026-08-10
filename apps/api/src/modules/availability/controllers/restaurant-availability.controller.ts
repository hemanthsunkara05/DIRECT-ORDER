import { Body, Controller, HttpCode, Inject, Patch, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { ToggleOrderingDto } from '../dto/toggle-ordering.dto.js';
import { RestaurantAvailabilityService } from '../services/restaurant-availability.service.js';

/** `PATCH /restaurant/availability` — STAFF-permitted (`restaurant:availability`), toggling `orderingEnabled` only. */
@Controller('restaurant/availability')
@UseGuards(AuthGuard, AuthorizationGuard)
export class RestaurantAvailabilityController {
  constructor(
    @Inject(RestaurantAvailabilityService)
    private readonly availability: RestaurantAvailabilityService,
  ) {}

  @Patch()
  @TenantScoped()
  @Permissions('restaurant:availability')
  @HttpCode(200)
  async toggle(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ) {
    const input = ToggleOrderingDto.parse(body);
    const restaurant = await this.availability.setOrderingEnabled(
      tenant.restaurantId,
      user.id,
      input.orderingEnabled,
    );
    return ok({ orderingEnabled: restaurant.orderingEnabled });
  }
}
