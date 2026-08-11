import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { OrderStatus } from '@prisma/client';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { CurrentAdmin } from '../../../platform/authorization/current-admin.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { AdminQueryRepository } from '../repositories/admin-query.repository.js';
import { AdminOrderService } from '../services/admin-order.service.js';
import { ReasonDto } from '../dto/reason.dto.js';

/** `/admin/orders*` (docs/04 §8.7: "Cross-tenant search" / "Reason required; goes through the state machine"). */
@Controller('admin/orders')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminOrdersController {
  constructor(
    @Inject(AdminQueryRepository) private readonly admin: AdminQueryRepository,
    @Inject(AdminOrderService) private readonly adminOrders: AdminOrderService,
  ) {}

  @Get()
  @Permissions('orders:read')
  @HttpCode(200)
  async list(
    @Query('status') status?: string,
    @Query('restaurantId') restaurantId?: string,
    @Query('orderNumber') orderNumber?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    const page = await this.admin.listOrders(
      { status: status as OrderStatus | undefined, restaurantId, orderNumber },
      { cursor, limit },
    );
    return okPage(
      page.items.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        restaurantId: o.restaurantId,
        status: o.status,
        customerName: o.customerName,
        payableTotalMinor: o.payableTotalMinor.toString(),
        createdAt: o.createdAt,
      })),
      {
        nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
        hasMore: page.hasMore,
        limit: limit ?? 20,
      },
    );
  }

  @Post(':id/cancel')
  @Permissions('orders:cancel')
  @HttpCode(200)
  async cancel(
    @CurrentAdmin() admin: { adminUserId: string },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = ReasonDto.parse(body);
    const result = await this.adminOrders.cancel(id, admin.adminUserId, input.reason);
    return ok({ status: result.order.status, applied: result.applied });
  }
}
