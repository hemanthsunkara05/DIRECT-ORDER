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
import type { Delivery, Order, OrderItem, OrderStatus, OrderStatusHistory, Payment } from '@prisma/client';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
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

  /**
   * City -> restaurant navigation tree for the Orders & payments page
   * (docs feedback: "orders should be sorted according to the
   * restaurants. city -> restaurant -> orders"). Returns counts only —
   * the actual order rows for a chosen restaurant still come from
   * `list()` above, paginated as before.
   */
  @Get('directory')
  @Permissions('orders:read')
  @HttpCode(200)
  async directory(@Query('status') status?: string) {
    const rows = await this.admin.listOrderDirectory({ status: status as OrderStatus | undefined });
    return ok(rows);
  }

  /**
   * Admin order detail (Phase 23a) — didn't exist before this phase;
   * clicking an order in `/admin/orders` did nothing (confirmed during
   * planning). Mirrors `RestaurantOrderController.toPublicOrderDetail()`'s
   * exact shape, including `delivery`, since this is also the host for
   * the new delivery-visibility panel (work item 3) — an admin
   * investigating a stuck order needs the same courier/status info a
   * restaurant already sees on their own order page, cross-tenant.
   */
  @Get(':id/detail')
  @Permissions('orders:read')
  @HttpCode(200)
  async detail(@Param('id') id: string) {
    const order = await this.admin.findOrderDetailById(id);
    if (!order) throw new NotFoundError('Order not found.');
    return ok(toAdminOrderDetail(order));
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

type AdminOrderDetail = Order & {
  items: OrderItem[];
  history: OrderStatusHistory[];
  payments: Payment[];
  delivery: Delivery | null;
};

/** Same shape as `RestaurantOrderController`'s `toPublicOrderDetail()` — deliberately identical field set, since an admin investigating a stuck order needs exactly what a restaurant already sees, cross-tenant. */
function toAdminOrderDetail(order: AdminOrderDetail) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    restaurantId: order.restaurantId,
    status: order.status,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    deliveryAddress: order.deliveryAddress,
    itemsSubtotalMinor: order.itemsSubtotalMinor.toString(),
    packagingFeeMinor: order.packagingFeeMinor.toString(),
    deliveryFeeMinor: order.deliveryFeeMinor.toString(),
    platformFeeMinor: order.platformFeeMinor.toString(),
    taxMinor: order.taxMinor.toString(),
    discountMinor: order.discountMinor.toString(),
    payableTotalMinor: order.payableTotalMinor.toString(),
    rejectionReason: order.rejectionReason,
    cancellationReason: order.cancellationReason,
    createdAt: order.createdAt,
    placedAt: order.placedAt,
    acceptedAt: order.acceptedAt,
    readyAt: order.readyAt,
    deliveredAt: order.deliveredAt,
    cancelledAt: order.cancelledAt,
    items: order.items.map((item) => ({
      id: item.id,
      nameSnapshot: item.nameSnapshot,
      descriptionSnapshot: item.descriptionSnapshot,
      unitPriceMinorSnapshot: item.unitPriceMinorSnapshot.toString(),
      quantity: item.quantity,
      lineTotalMinor: item.lineTotalMinor.toString(),
    })),
    history: order.history.map((h) => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      actorType: h.actorType,
      reason: h.reason,
      createdAt: h.createdAt,
    })),
    payment: order.payments[0]
      ? {
          status: order.payments[0].status,
          amountMinor: order.payments[0].amountMinor.toString(),
          capturedMinor: order.payments[0].capturedMinor.toString(),
          refundedMinor: order.payments[0].refundedMinor.toString(),
          method: order.payments[0].method,
        }
      : null,
    // Same allowlist as the restaurant-facing delivery view (provider
    // identity + providerDeliveryId included, no credentials) — work
    // item 3's whole purpose is giving an admin this exact picture
    // without having to go elsewhere.
    delivery: order.delivery
      ? {
          status: order.delivery.status,
          provider: order.delivery.provider,
          providerDeliveryId: order.delivery.providerDeliveryId,
          courierName: order.delivery.courierName,
          courierPhone: order.delivery.courierPhone,
          trackingUrl: order.delivery.trackingUrl,
          quotedFeeMinor: order.delivery.quotedFeeMinor?.toString() ?? null,
          actualFeeMinor: order.delivery.actualFeeMinor?.toString() ?? null,
          attemptCount: order.delivery.attemptCount,
          estimatedPickupAt: order.delivery.estimatedPickupAt,
          estimatedDeliveryAt: order.delivery.estimatedDeliveryAt,
          pickedUpAt: order.delivery.pickedUpAt,
          deliveredAt: order.delivery.deliveredAt,
          failureReason: order.delivery.failureReason,
        }
      : null,
  };
}
