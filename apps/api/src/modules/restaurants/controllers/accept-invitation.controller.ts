import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { AcceptInvitationDto } from '../dto/accept-invitation.dto.js';
import { StaffManagementService } from '../services/staff-management.service.js';

/**
 * Mounted at `/auth/invitations/accept` (docs/04-api-specification.md
 * §8.2) but lives in RestaurantsModule, not IdentityModule — it needs
 * StaffManagementService, and IdentityModule already needs to be
 * importable by RestaurantsModule (for AuthGuard), so putting this
 * controller in IdentityModule instead would create a circular module
 * dependency between the two. The route path is a public contract; the
 * module that happens to implement it is an internal detail.
 *
 * Requires an existing session (`@UseGuards(AuthGuard)`) — accepting an
 * invitation never creates an account. An invitee with no account
 * registers normally first (their invitation email tells them to), then
 * accepts while logged in as that email.
 */
@Controller('auth/invitations')
export class AcceptInvitationController {
  constructor(@Inject(StaffManagementService) private readonly staff: StaffManagementService) {}

  @Post('accept')
  @UseGuards(AuthGuard)
  @HttpCode(200)
  async accept(@CurrentUser() user: User, @Body() body: unknown) {
    const input = AcceptInvitationDto.parse(body);
    const result = await this.staff.accept(user.id, user.email ?? '', input.token);

    if (result.outcome !== 'ACCEPTED') {
      throw new ValidationError(
        result.outcome === 'EXPIRED'
          ? 'This invitation has expired.'
          : result.outcome === 'EMAIL_MISMATCH'
            ? 'This invitation was sent to a different email address.'
            : 'This invitation is invalid or has already been used.',
      );
    }

    return ok({ status: 'ok', restaurantId: result.restaurantId });
  }
}
