import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Order, SupportCase, SupportMessage } from '@prisma/client';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator.js';
import { hashToken } from '../../orders/services/cart.service.js';
import { OrderRepository } from '../../orders/repositories/order.repository.js';
import { SupportMessageRepository } from '../repositories/support-message.repository.js';
import { SupportAttachmentService } from '../services/support-attachment.service.js';
import { SupportCaseService } from '../services/support-case.service.js';
import {
  CreatePublicSupportCaseDto,
  PostPublicSupportMessageDto,
  PresignPublicSupportAttachmentDto,
} from '../dto/create-public-support-case.dto.js';

/** BR/docs (Guest complaint path spec): every status except `PENDING_PAYMENT` — there is nothing to complain about before payment even completes, but every other status (including failure/terminal ones) is fair game. */
const COMPLAINABLE_STATUSES = new Set<Order['status']>([
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
]);

/**
 * `/public/orders/:orderNumber/support-cases*` — guest complaint path.
 * Mirrors `MeSupportController` one-for-one, reusing `SupportCaseService`/
 * `SupportAttachmentService` unchanged; the only difference is how the
 * caller's identity is established. A guest checkout still creates a real
 * `Customer` row (`CheckoutService`, one per checkout) and `Order.customerId`
 * always points to it, so `order.customerId` IS this guest's identity —
 * proven by the same `?token=` ownership check `OrderTrackingController`
 * and `ReviewService.submit()` already use, not a new identity model.
 */
@Controller('public/orders/:orderNumber/support-cases')
export class PublicSupportController {
  constructor(
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(SupportMessageRepository) private readonly messages: SupportMessageRepository,
    @Inject(SupportCaseService) private readonly caseService: SupportCaseService,
    @Inject(SupportAttachmentService) private readonly attachmentService: SupportAttachmentService,
  ) {}

  @Get()
  @HttpCode(200)
  async list(@Param('orderNumber') orderNumber: string, @Query('token') token?: string) {
    const order = await this.requireOwnedOrder(orderNumber, token);
    const page = await this.caseService.listForCustomerOrder(order.customerId, order.id);
    return okPage(page.items.map(toCaseSummary), {
      nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
      hasMore: page.hasMore,
      limit: 20,
    });
  }

  @Post()
  @RateLimit({ limit: 5, windowSeconds: 3600 })
  @HttpCode(201)
  async create(@Param('orderNumber') orderNumber: string, @Body() body: unknown) {
    const input = CreatePublicSupportCaseDto.parse(body);
    const order = await this.requireOwnedOrder(orderNumber, input.token);
    if (!COMPLAINABLE_STATUSES.has(order.status)) {
      throw new ValidationError('This order cannot be reported on yet.');
    }
    const created = await this.caseService.createForCustomer(order.customerId, {
      category: input.category,
      subject: input.subject,
      description: input.description,
      orderNumber,
    });
    return ok(toCaseSummary(created));
  }

  @Get(':id')
  @HttpCode(200)
  async detail(
    @Param('orderNumber') orderNumber: string,
    @Param('id') id: string,
    @Query('token') token?: string,
  ) {
    const order = await this.requireOwnedOrder(orderNumber, token);
    const found = await this.requireOwnedCase(order, id);
    const publicMessages = await this.messages.listPublicForCase(found.id);
    return ok({ ...toCaseSummary(found), messages: publicMessages.map(toPublicMessage) });
  }

  @Post(':id/messages')
  @RateLimit({ limit: 10, windowSeconds: 900 })
  @HttpCode(201)
  async postMessage(
    @Param('orderNumber') orderNumber: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = PostPublicSupportMessageDto.parse(body);
    const order = await this.requireOwnedOrder(orderNumber, input.token);
    const found = await this.requireOwnedCase(order, id);
    const message = await this.caseService.postAsCustomer(found, order.customerId, input.body, input.attachments);
    return ok(toPublicMessage(message));
  }

  @Post(':id/attachments/presign')
  @HttpCode(200)
  async presignAttachment(
    @Param('orderNumber') orderNumber: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = PresignPublicSupportAttachmentDto.parse(body);
    const order = await this.requireOwnedOrder(orderNumber, input.token);
    const found = await this.requireOwnedCase(order, id);
    return ok(await this.attachmentService.presign(found.id, input));
  }

  @Get(':id/attachments/:attachmentId')
  @HttpCode(200)
  async downloadAttachment(
    @Param('orderNumber') orderNumber: string,
    @Param('id') id: string,
    @Param('attachmentId') attachmentId: string,
    @Query('token') token?: string,
  ) {
    const order = await this.requireOwnedOrder(orderNumber, token);
    const found = await this.requireOwnedCase(order, id);
    const url = await this.attachmentService.presignDownload(found.id, attachmentId, { publicOnly: true });
    return ok({ url });
  }

  /** Same ownership proof `OrderTrackingController.assertOwnership` uses — 404, never a distinguishable "wrong token" response. */
  private async requireOwnedOrder(orderNumber: string, token: string | undefined): Promise<Order> {
    if (!token) throw new NotFoundError('Order not found.');
    const order = await this.orders.findByOrderNumber(orderNumber);
    if (!order || order.accessTokenHash !== hashToken(token)) {
      throw new NotFoundError('Order not found.');
    }
    return order;
  }

  /** `requireForCustomer` already enforces the case belongs to this exact customer — a token valid for order A can never reach a case belonging to order B, even by guessed id. */
  private async requireOwnedCase(order: Order, caseId: string): Promise<SupportCase> {
    return this.caseService.requireForCustomer(caseId, order.customerId);
  }
}

function toCaseSummary(supportCase: SupportCase) {
  return {
    id: supportCase.id,
    caseNumber: supportCase.caseNumber,
    category: supportCase.category,
    priority: supportCase.priority,
    status: supportCase.status,
    subject: supportCase.subject,
    description: supportCase.description,
    orderId: supportCase.orderId,
    resolvedAt: supportCase.resolvedAt,
    resolutionNote: supportCase.resolutionNote,
    firstResponseAt: supportCase.firstResponseAt,
    createdAt: supportCase.createdAt,
  };
}

/** Same "never a field left to leak visibility" posture as `MeSupportController.toPublicMessage` — built only from already-PUBLIC-filtered rows. */
function toPublicMessage(message: SupportMessage) {
  return {
    id: message.id,
    authorType: message.authorType,
    body: message.body,
    createdAt: message.createdAt,
  };
}
