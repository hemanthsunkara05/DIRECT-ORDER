import { Controller, Get, HttpCode, Inject, Query, UseGuards } from '@nestjs/common';
import { okPage } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { AuditService } from '../../../platform/audit/audit.service.js';

/**
 * `GET /admin/audit-logs` (docs/04 §8.7, SUPER_ADMIN-only: "Read-only.
 * No write endpoint exists"). There genuinely is no corresponding POST/
 * PATCH/DELETE anywhere in this controller, or anywhere else in the
 * codebase — `AuditService` itself exposes no update/delete method (see
 * its own doc comment), so there is no code path that COULD write one
 * even by mistake.
 */
@Controller('admin/audit-logs')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminAuditController {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  @Get()
  @Permissions('audit:read')
  @HttpCode(200)
  async list(
    @Query('actorType') actorType?: string,
    @Query('entityType') entityType?: string,
    @Query('restaurantId') restaurantId?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    const page = await this.audit.findAll({ actorType, entityType, restaurantId, cursor, limit });
    return okPage(page.items, {
      nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
      hasMore: page.hasMore,
      limit: limit ?? 20,
    });
  }
}
