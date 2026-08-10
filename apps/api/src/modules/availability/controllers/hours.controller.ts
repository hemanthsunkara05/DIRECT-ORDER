import { Body, Controller, Get, HttpCode, Inject, Put, UseGuards } from '@nestjs/common';
import type { OperatingHours, User } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { SetHoursDto } from '../dto/set-hours.dto.js';
import { RestaurantAvailabilityService } from '../services/restaurant-availability.service.js';
import { formatTimeOfDay } from '../time-of-day.js';

/** `GET/PUT /restaurant/hours` — both MANAGER-only (`restaurant:hours`), matching docs/04-api-specification.md §8.5 exactly. */
@Controller('restaurant/hours')
@UseGuards(AuthGuard, AuthorizationGuard)
export class HoursController {
  constructor(
    @Inject(RestaurantAvailabilityService)
    private readonly availability: RestaurantAvailabilityService,
  ) {}

  @Get()
  @TenantScoped()
  @Permissions('restaurant:hours')
  @HttpCode(200)
  async get(@CurrentTenant() tenant: TenantContext) {
    const rows = await this.availability.getHours(tenant.restaurantId);
    return ok(rows.map(toPublicHoursRow));
  }

  @Put()
  @TenantScoped()
  @Permissions('restaurant:hours')
  @HttpCode(200)
  async set(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ) {
    const input = SetHoursDto.parse(body);
    const rows = await this.availability.setHours(tenant.restaurantId, user.id, input);
    return ok(rows.map(toPublicHoursRow));
  }
}

function toPublicHoursRow(row: OperatingHours) {
  return {
    id: row.id,
    dayOfWeek: row.dayOfWeek,
    opensAt: formatTimeOfDay(row.opensAt),
    closesAt: formatTimeOfDay(row.closesAt),
    isClosed: row.isClosed,
  };
}
