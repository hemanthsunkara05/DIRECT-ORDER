import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { ClosurePeriod, User } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { CreateClosureDto } from '../dto/create-closure.dto.js';
import { RestaurantAvailabilityService } from '../services/restaurant-availability.service.js';

/**
 * `/restaurant/closures*`. `docs/04-api-specification.md §8.5` documents
 * only `POST`; `GET` (list) and `DELETE` (end early) are a minimal,
 * necessary extension — without a way to see or end a closure, the
 * feature isn't actually usable — same kind of deliberate small
 * addition as Phase 5's client-facing `slug` field.
 */
@Controller('restaurant/closures')
@UseGuards(AuthGuard, AuthorizationGuard)
export class ClosuresController {
  constructor(
    @Inject(RestaurantAvailabilityService)
    private readonly availability: RestaurantAvailabilityService,
  ) {}

  @Get()
  @TenantScoped()
  @Permissions('restaurant:hours')
  @HttpCode(200)
  async list(@CurrentTenant() tenant: TenantContext) {
    const closures = await this.availability.listClosures(tenant.restaurantId);
    return ok(closures.map(toPublicClosure));
  }

  @Post()
  @TenantScoped()
  @Permissions('restaurant:hours')
  @HttpCode(201)
  async create(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ) {
    const input = CreateClosureDto.parse(body);
    const closure = await this.availability.createClosure(
      tenant.restaurantId,
      { type: 'RESTAURANT_USER', id: user.id },
      input,
    );
    return ok(toPublicClosure(closure));
  }

  @Delete(':id')
  @TenantScoped()
  @Permissions('restaurant:hours')
  @HttpCode(200)
  async end(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    await this.availability.endClosure(
      tenant.restaurantId,
      { type: 'RESTAURANT_USER', id: user.id },
      id,
    );
    return ok({ status: 'ok' });
  }
}

function toPublicClosure(closure: ClosurePeriod) {
  return {
    id: closure.id,
    startsAt: closure.startsAt,
    endsAt: closure.endsAt,
    reason: closure.reason,
  };
}
