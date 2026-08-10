import { Body, Controller, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import type { User } from '@prisma/client';
import { ok } from '../../../platform/http/response-envelope.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { PresignUploadDto } from '../dto/presign-upload.dto.js';
import { VerifyUploadDto } from '../dto/verify-upload.dto.js';
import { UploadService } from '../uploads/upload.service.js';

@Controller('restaurant/uploads')
@UseGuards(AuthGuard, AuthorizationGuard)
export class UploadController {
  constructor(@Inject(UploadService) private readonly uploads: UploadService) {}

  @Post('presign')
  @TenantScoped()
  @Permissions('restaurant:branding')
  @RateLimit({ limit: 20, windowSeconds: 3600 })
  @HttpCode(200)
  async presign(@CurrentTenant() tenant: TenantContext, @Body() body: unknown) {
    const input = PresignUploadDto.parse(body);
    return ok(await this.uploads.presign(tenant.restaurantId, input));
  }

  @Post('verify')
  @TenantScoped()
  @Permissions('restaurant:branding')
  @HttpCode(200)
  async verify(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Body() body: unknown,
  ) {
    const input = VerifyUploadDto.parse(body);
    const result = await this.uploads.verify(
      tenant.restaurantId,
      user.id,
      input.key,
      input.contentType,
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
