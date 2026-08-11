import { Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { CurrentAdmin } from '../../../platform/authorization/current-admin.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { AdminQueryRepository } from '../repositories/admin-query.repository.js';
import { AdminUserService } from '../services/admin-user.service.js';

/** `/admin/users*` (docs/04 §8.7: "Search — never returns hashes" / "Revokes sessions"). */
@Controller('admin/users')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminUsersController {
  constructor(
    @Inject(AdminQueryRepository) private readonly admin: AdminQueryRepository,
    @Inject(AdminUserService) private readonly adminUserService: AdminUserService,
  ) {}

  @Get()
  @Permissions('users:read')
  @HttpCode(200)
  async list(
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    const page = await this.admin.listUsers({ search }, { cursor, limit });
    return okPage(
      // Never passwordHash/mfaSecret — the same field allowlist AuthController.toPublicUser() already applies to every other user-facing response.
      page.items.map((u) => ({
        id: u.id,
        email: u.email,
        phone: u.phone,
        fullName: u.fullName,
        status: u.status,
        createdAt: u.createdAt,
      })),
      {
        nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
        hasMore: page.hasMore,
        limit: limit ?? 20,
      },
    );
  }

  @Post(':id/disable')
  @Permissions('users:disable')
  @HttpCode(200)
  async disable(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('id') adminUserRowId: string,
  ) {
    await this.adminUserService.disable(adminUserRowId, admin.adminUserId);
    return ok({ status: 'ok' });
  }
}
