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
  Res,
  Sse,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import type {
  Delivery,
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
import type { OrderWithItems } from '../repositories/order.repository.js';

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
    @Query('today') todayRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    const page = await this.orders.list(tenant.restaurantId, {
      status: parseStatusFilter(status),
      cursor,
      limit,
      today: todayRaw === 'true',
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

  /**
   * History export (docs feedback: "month data should be stored in
   * excel kind of data") — a CSV download of every placed order in
   * `[from, to]`, restaurant-timezone bounded. Declared before `:id`
   * for the same routing-order reason as `stream` above: Nest matches
   * in declaration order, so `:id` would otherwise swallow the literal
   * `export` segment. Bypasses the JSON response envelope entirely
   * (`@Res()`, not a return value) — this endpoint's whole purpose is a
   * downloadable file, not a `{data: ...}` API response.
   */
  @Get('export')
  @TenantScoped()
  @Permissions('orders:read')
  async export(
    @CurrentTenant() tenant: TenantContext,
    @Res() reply: FastifyReply,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new ValidationError('`from` and `to` are required, formatted YYYY-MM-DD.');
    }
    const orders = await this.orders.exportOrders(tenant.restaurantId, from, to);
    const csv = toOrdersCsv(orders);
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="orders_${from}_to_${to}.csv"`)
      .send(csv);
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

  /** Restaurant-initiated cancellation-after-accept (docs/06 BR-174) — MANAGER/OWNER only (`orders:cancel`), reason required, full refund. */
  @Post(':id/cancel')
  @TenantScoped()
  @Permissions('orders:cancel')
  @HttpCode(200)
  async cancel(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    requireIdempotencyKey(idempotencyKey);
    const input = RejectOrderDto.parse(body);
    const result = await this.orders.cancel(tenant.restaurantId, id, user.id, input.reason);
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

/** Excel/Sheets opens this directly (docs feedback) — one row per order, quoted fields, CRLF line endings per RFC 4180. */
function toOrdersCsv(orders: OrderWithItems[]): string {
  const header = [
    'Order number',
    'Placed at',
    'Status',
    'Customer',
    'Phone',
    'Items',
    'Payable total (INR)',
  ];
  const rows = orders.map((order) => [
    order.orderNumber,
    order.placedAt ? order.placedAt.toISOString() : '',
    order.status,
    order.customerName,
    order.customerPhone,
    order.items.map((item) => `${item.quantity}x ${item.nameSnapshot}`).join('; '),
    (Number(order.payableTotalMinor) / 100).toFixed(2),
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function toPublicOrderSummary(order: OrderWithItems) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    customerName: order.customerName,
    payableTotalMinor: order.payableTotalMinor.toString(),
    createdAt: order.createdAt,
    placedAt: order.placedAt,
    // Queue preview (docs feedback: "better to show the items of order
    // rather than name of customer") — name + quantity only, matching
    // the summary's own "preview, not full detail" scope; full pricing
    // per line still comes from GET :id.
    items: order.items.map((item) => ({ name: item.nameSnapshot, quantity: item.quantity })),
  };
}

type OrderDetail = Order & {
  items: OrderItem[];
  history: OrderStatusHistory[];
  payments: Payment[];
  delivery: Delivery | null;
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
    // Restaurant-facing delivery view (docs/14-acceptance-criteria.md
    // "restaurant delivery view") — the provider identity string
    // (`mock`/`uber_direct`) and providerDeliveryId are useful for
    // support/debugging and are not credentials, so unlike the customer
    // tracking view this includes them.
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
