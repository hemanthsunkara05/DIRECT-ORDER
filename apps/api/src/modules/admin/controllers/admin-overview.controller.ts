import { Controller, Get, HttpCode, Inject, UseGuards } from '@nestjs/common';
import { ok } from '../../../platform/http/response-envelope.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { RedisService } from '../../../platform/redis/redis.service.js';

/**
 * `GET /admin/overview`, `GET /admin/health` (docs/04 §8.7, "Any
 * admin"). `restaurant:read` is used as the permission gate on both —
 * it is the one permission every admin role holds (docs/05 §9.2's
 * matrix), the closest match to "any admin" the catalogue actually
 * encodes; there is no dedicated "admin-only, no specific capability"
 * permission and adding one just for this would be one more catalogue
 * row nothing else needs.
 *
 * `overview` reports LIVE counts, not the "platform metrics from
 * rollups" docs/04 describes — `analytics.rollup_daily` (docs/07 §12's
 * job catalogue) is Phase 17 (Support and analytics) scope; no rollup
 * table exists yet to read from. An honestly-scoped placeholder, not a
 * finished implementation — flagged in PHASE_REPORTS.md.
 */
@Controller('admin')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminOverviewController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  @Get('overview')
  @Permissions('restaurant:read')
  @HttpCode(200)
  async overview() {
    const [restaurantsByStatus, ordersToday, activeAdmins] = await Promise.all([
      this.prisma.restaurant.groupBy({ by: ['status'], _count: true }),
      this.prisma.order.count({
        where: { createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
      }),
      this.prisma.adminUser.count({ where: { status: 'ACTIVE' } }),
    ]);
    return ok({
      restaurantsByStatus: Object.fromEntries(restaurantsByStatus.map((r) => [r.status, r._count])),
      ordersToday,
      activeAdmins,
    });
  }

  @Get('health')
  @Permissions('restaurant:read')
  @HttpCode(200)
  async health() {
    const [database, redis] = await Promise.all([
      this.prisma
        .ping()
        .then(() => ({ status: 'ok' as const }))
        .catch((error: unknown) => ({
          status: 'error' as const,
          error: error instanceof Error ? error.message : 'Unknown database error',
        })),
      this.redis.client
        .ping()
        .then(() => ({ status: 'ok' as const }))
        .catch((error: unknown) => ({
          status: 'error' as const,
          error: error instanceof Error ? error.message : 'Unknown redis error',
        })),
    ]);
    return ok({ database, redis });
  }
}
