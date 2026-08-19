import { Body, Controller, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { ok } from '../../../platform/http/response-envelope.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentAdmin } from '../../../platform/authorization/current-admin.decorator.js';
import { PresignUploadDto } from '../../restaurants/dto/presign-upload.dto.js';
import { VerifyUploadDto } from '../../restaurants/dto/verify-upload.dto.js';
import { UploadService } from '../../restaurants/uploads/upload.service.js';

/**
 * Admin-authorized upload (Phase 23a, TODOS.md "Admin-authorized
 * menu-image upload") — closes a real gap in Phase 22's own headline
 * use case: an admin building a menu from photos an owner texted them
 * could enter every field except the photo itself, since the existing
 * `/restaurant/uploads/*` endpoints are tenant-scoped
 * (`@TenantScoped()`, `restaurant:branding`, membership-gated) and an
 * admin has no `RestaurantStaff` row to satisfy that.
 *
 * Reuses `UploadService` completely unchanged (Phase 5) — it already
 * takes `restaurantId` as a plain parameter rather than deriving it
 * from tenant context, so no service change was needed, just a
 * differently-gated controller that takes the target restaurant from
 * the route (`:restaurantId`) instead of `CurrentTenant()`. Gated by
 * `restaurant:admin_edit` — the same permission Phase 22's other
 * admin-on-behalf-of-restaurant content endpoints already use
 * (`['ADMIN_OPERATIONS', 'SUPER_ADMIN']`), not a new permission.
 */
@Controller('admin/restaurants/:restaurantId/uploads')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminUploadController {
  constructor(@Inject(UploadService) private readonly uploads: UploadService) {}

  @Post('presign')
  @Permissions('restaurant:admin_edit')
  @RateLimit({ limit: 20, windowSeconds: 3600 })
  @HttpCode(200)
  async presign(@Param('restaurantId') restaurantId: string, @Body() body: unknown) {
    const input = PresignUploadDto.parse(body);
    return ok(await this.uploads.presign(restaurantId, input));
  }

  @Post('verify')
  @Permissions('restaurant:admin_edit')
  @HttpCode(200)
  async verify(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('restaurantId') restaurantId: string,
    @Body() body: unknown,
  ) {
    const input = VerifyUploadDto.parse(body);
    const result = await this.uploads.verify(
      restaurantId,
      admin.adminUserId,
      input.key,
      input.contentType,
      'ADMIN',
    );
    if (result !== 'VERIFIED') {
      throw new ValidationError(
        result === 'CONTENT_MISMATCH'
          ? 'The uploaded file does not match its declared type.'
          : 'No file was found at that upload key.',
      );
    }
    return ok({ status: 'ok' });
  }
}
