import { Controller, Get, HttpCode, Inject, Query, UseGuards } from '@nestjs/common';
import { okPage } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { AdminQueryRepository } from '../repositories/admin-query.repository.js';
import { maskReference } from '../mask-reference.js';

function parsePageParams(limitRaw?: string): number | undefined {
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
    throw new ValidationError('limit must be a positive integer.');
  }
  return limit;
}

/** `/admin/payments`, `/admin/refunds` (docs/04 §8.7, FINANCE+: "Masked provider references"). */
@Controller('admin')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminPaymentsController {
  constructor(@Inject(AdminQueryRepository) private readonly admin: AdminQueryRepository) {}

  @Get('payments')
  @Permissions('payments:read')
  @HttpCode(200)
  async listPayments(
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = parsePageParams(limitRaw);
    const page = await this.admin.listPayments({ status }, { cursor, limit });
    return okPage(
      page.items.map((p) => ({
        id: p.id,
        orderId: p.orderId,
        provider: p.provider,
        // Never the raw provider order/payment id — masked, per docs/14's Phase 13 criterion.
        providerOrderId: maskReference(p.providerOrderId),
        providerPaymentId: maskReference(p.providerPaymentId),
        status: p.status,
        amountMinor: p.amountMinor.toString(),
        capturedMinor: p.capturedMinor.toString(),
        refundedMinor: p.refundedMinor.toString(),
        currency: p.currency,
        method: p.method,
        createdAt: p.createdAt,
      })),
      {
        nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
        hasMore: page.hasMore,
        limit: limit ?? 20,
      },
    );
  }

  @Get('refunds')
  @Permissions('payments:read')
  @HttpCode(200)
  async listRefunds(
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = parsePageParams(limitRaw);
    const page = await this.admin.listRefunds({ status }, { cursor, limit });
    return okPage(
      page.items.map((r) => ({
        id: r.id,
        paymentId: r.paymentId,
        orderId: r.orderId,
        amountMinor: r.amountMinor.toString(),
        reason: r.reason,
        status: r.status,
        providerRefundId: maskReference(r.providerRefundId),
        initiatedByActorType: r.initiatedByActorType,
        createdAt: r.createdAt,
      })),
      {
        nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
        hasMore: page.hasMore,
        limit: limit ?? 20,
      },
    );
  }
}
