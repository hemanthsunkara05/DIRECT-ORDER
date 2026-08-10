import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  MessageEvent,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import type {
  Order,
  OrderItem,
  OrderStatus,
  OrderStatusHistory,
  Payment,
  User,
} from '@prisma/client';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { CurrentTenant } from '../../../platform/authorization/current-tenant.decorator.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { TenantScoped } from '../../../platform/authorization/tenant-scoped.decorator.js';
import type { TenantContext } from '../../../platform/authorization/tenant-context.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { RejectOrderDto } from '../dto/reject-order.dto.js';
import { RestaurantOrderService } from '../services/restaurant-order.service.js';
import { OrderStreamService } from '../services/order-stream.service.js';

const ORDER_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT',
  'PLACED',
  'PAYMENT_FAILED',
  'EXPIRED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'DELIVERY_FAILED',
  'REJECTED',
  'CANCELLED',
];

/**
 * `/restaurant/orders*` (docs/04-api-specification.md §8.5). Every
 * handler is STAFF-permitted (`orders:read`/`orders:accept`/
 * `orders:reject`/`orders:transition`) — the permission catalogue
 * already had these mapped before this phase (Phase 4). `GET .../stream`
 * is declared before `GET .../:id` deliberately: Nest matches routes on
 * a controller in declaration order, so `:id` would otherwise swallow
 * the literal `stream` segment as an id.
 */
@Controller('restaurant/orders')
@UseGuards(AuthGuard, AuthorizationGuard)
export class RestaurantOrderController {
  constructor(
    @Inject(RestaurantOrderService) private readonly orders: RestaurantOrderService,
    @Inject(OrderStreamService) private readonly stream: OrderStreamService,
  ) {}

  @Get()
  @TenantScoped()
  @Permissions('orders:read')
  @HttpCode(200)
  async list(
    @CurrentTenant() tenant: TenantContext,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    const page = await this.orders.list(tenant.restaurantId, {
      status: parseStatusFilter(status),
      cursor,
      limit,
    });
    return okPage(page.items.map(toPublicOrderSummary), {
      nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
      hasMore: page.hasMore,
      limit: limit ?? 20,
    });
  }

  /**
   * `Last-Event-ID` follows the SSE spec's native reconnect header;
   * `?lastEventId=` is what this app's own frontend hook sends on a
   * manually-managed (re)connect, where it controls the URL directly
   * rather than relying on the browser's automatic-reconnect behavior
   * (which never lets JavaScript choose the resume point on the first
   * connection after a page load).
   */
  @Sse('stream')
  @TenantScoped()
  @Permissions('orders:read')
  streamOrders(
    @CurrentTenant() tenant: TenantContext,
    @Req() request: FastifyRequest,
    @Query('lastEventId') lastEventIdQuery?: string,
  ): Observable<MessageEvent> {
    const headerValue = request.headers['last-event-id'];
    const lastEventIdHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    return this.stream.stream(tenant.restaurantId, lastEventIdQuery ?? lastEventIdHeader);
  }

  @Get(':id')
  @TenantScoped()
  @Permissions('orders:read')
  @HttpCode(200)
  async detail(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
  ) {
    const order = await this.orders.detail(tenant.restaurantId, id, user.id);
    return ok(toPublicOrderDetail(order));
  }

  @Post(':id/accept')
  @TenantScoped()
  @Permissions('orders:accept')
  @HttpCode(200)
  async accept(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.orders.accept(tenant.restaurantId, id, user.id);
    return ok({ status: result.order.status, applied: result.applied });
  }

  @Post(':id/reject')
  @TenantScoped()
  @Permissions('orders:reject')
  @HttpCode(200)
  async reject(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const input = RejectOrderDto.parse(body);
    const result = await this.orders.reject(tenant.restaurantId, id, user.id, input.reason);
    return ok({ status: result.order.status, applied: result.applied });
  }

  @Post(':id/preparing')
  @TenantScoped()
  @Permissions('orders:transition')
  @HttpCode(200)
  async preparing(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.orders.preparing(tenant.restaurantId, id, user.id);
    return ok({ status: result.order.status, applied: result.applied });
  }

  @Post(':id/ready')
  @TenantScoped()
  @Permissions('orders:transition')
  @HttpCode(200)
  async ready(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const result = await this.orders.ready(tenant.restaurantId, id, user.id);
    return ok({ status: result.order.status, applied: result.applied });
  }
}

function requireIdempotencyKey(idempotencyKey: string | undefined): void {
  if (!idempotencyKey || idempotencyKey.trim().length === 0) {
    throw new ValidationError('The Idempotency-Key header is required.');
  }
}

function parseStatusFilter(status: string | undefined): OrderStatus[] | undefined {
  if (!status) return undefined;
  const values = status
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = values.filter((v) => !ORDER_STATUSES.includes(v as OrderStatus));
  if (invalid.length > 0) {
    throw new ValidationError(`Invalid status filter value(s): ${invalid.join(', ')}.`);
  }
  return values as OrderStatus[];
}

function toPublicOrderSummary(order: Order) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    customerName: order.customerName,
    payableTotalMinor: order.payableTotalMinor.toString(),
    createdAt: order.createdAt,
    placedAt: order.placedAt,
  };
}

type OrderDetail = Order & {
  items: OrderItem[];
  history: OrderStatusHistory[];
  payments: Payment[];
};

function toPublicOrderDetail(order: OrderDetail) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
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
  };
}
