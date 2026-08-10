import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { ChangeRoleDto } from '../dto/change-role.dto.js';
import { InviteStaffDto } from '../dto/invite-staff.dto.js';
import type { RestaurantStaffWithUser } from '../repositories/restaurant-staff.repository.js';
import { StaffManagementService } from '../services/staff-management.service.js';

/**
 * `/restaurant/staff*` (docs/04-api-specification.md §8.5). Invitation
 * acceptance is deliberately NOT here — it has no tenant to resolve yet
 * (the accepter isn't a member until the invitation succeeds), so it
 * lives at `POST /auth/invitations/accept` instead, alongside Phase 3's
 * other pre-membership auth flows.
 */
@Controller('restaurant/staff')
@UseGuards(AuthGuard, AuthorizationGuard)
export class StaffController {
  constructor(@Inject(StaffManagementService) private readonly staff: StaffManagementService) {}

  @Get()
  @TenantScoped()
  @Permissions('staff:read')
  @HttpCode(200)
  async list(@CurrentTenant() tenant: TenantContext) {
    const members = await this.staff.list(tenant.restaurantId);
    return ok(members.map(toPublicStaff));
  }

  @Post('invitations')
  @TenantScoped()
  @Permissions('staff:invite')
  @HttpCode(201)
  async invite(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ) {
    const input = InviteStaffDto.parse(body);
    const { invitation } = await this.staff.invite(
      tenant.restaurantId,
      user.id,
      input.email,
      input.role,
    );
    // The raw token is never returned in the API response — only ever
    // delivered out of band (email, Phase 12's real notifier; a console
    // placeholder for now, matching AuthNotifierService's Phase 3 pattern).
    return ok({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    });
  }

  @Patch(':id/role')
  @TenantScoped()
  @Permissions('staff:role_change')
  @HttpCode(200)
  async changeRole(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') staffId: string,
    @Body() body: unknown,
  ) {
    const input = ChangeRoleDto.parse(body);
    await this.staff.changeRole(tenant.restaurantId, user.id, staffId, input.role);
    return ok({ status: 'ok' });
  }

  @Delete(':id')
  @TenantScoped()
  @Permissions('staff:disable')
  @HttpCode(200)
  async disable(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') staffId: string,
  ) {
    await this.staff.disable(tenant.restaurantId, user.id, staffId);
    return ok({ status: 'ok' });
  }
}

function toPublicStaff(staff: RestaurantStaffWithUser) {
  return {
    id: staff.id,
    role: staff.role,
    status: staff.status,
    joinedAt: staff.joinedAt,
    user: {
      id: staff.user.id,
      fullName: staff.user.fullName,
      email: staff.user.email,
      phone: staff.user.phone,
    },
  };
}
