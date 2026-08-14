import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ok } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { CurrentAdmin } from '../../../platform/authorization/current-admin.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { AdminLoyaltyService } from '../services/admin-loyalty.service.js';
import { LoyaltyAdjustDto } from '../dto/loyalty-adjust.dto.js';

/** `/admin/loyalty/:customerId*` (docs/04-api-specification.md §8.8). */
@Controller('admin/loyalty')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminLoyaltyController {
  constructor(@Inject(AdminLoyaltyService) private readonly loyalty: AdminLoyaltyService) {}

  @Get(':customerId')
  @Permissions('loyalty:read')
  @HttpCode(200)
  async view(
    @Param('customerId') customerId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    const view = await this.loyalty.view(customerId, { cursor, limit });
    return ok({
      account: view.account
        ? {
            customerId: view.account.customerId,
            balancePoints: view.account.balancePoints,
            lifetimeEarned: view.account.lifetimeEarned,
            lifetimeRedeemed: view.account.lifetimeRedeemed,
            status: view.account.status,
          }
        : null,
      ledger: view.ledger.items.map((entry) => ({
        id: entry.id,
        type: entry.type,
        points: entry.points,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        description: entry.description,
        actorType: entry.actorType,
        actorId: entry.actorId,
        createdAt: entry.createdAt,
      })),
      pagination: {
        nextCursor: view.ledger.hasMore ? (view.ledger.items.at(-1)?.id ?? null) : null,
        hasMore: view.ledger.hasMore,
        limit: limit ?? 20,
      },
    });
  }

  @Post(':customerId/adjust')
  @Permissions('loyalty:adjust')
  @HttpCode(200)
  async adjust(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('customerId') customerId: string,
    @Body() body: unknown,
  ) {
    const input = LoyaltyAdjustDto.parse(body);
    const account = await this.loyalty.adjust(
      customerId,
      input.points,
      input.reason,
      admin.adminUserId,
    );
    return ok({
      customerId: account.customerId,
      balancePoints: account.balancePoints,
      lifetimeEarned: account.lifetimeEarned,
      lifetimeRedeemed: account.lifetimeRedeemed,
    });
  }
}
