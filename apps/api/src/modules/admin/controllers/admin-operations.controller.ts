import { Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { AdminQueryRepository } from '../repositories/admin-query.repository.js';
import { NotificationRepository } from '../../notifications/repositories/notification.repository.js';
import { NotificationDispatchService } from '../../notifications/services/notification-dispatch.service.js';
import { ReconciliationIssueRepository } from '../../payments/repositories/reconciliation-issue.repository.js';

function parseLimit(limitRaw?: string): number | undefined {
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
    throw new ValidationError('limit must be a positive integer.');
  }
  return limit;
}

/**
 * `/admin/deliveries`, `/admin/notifications*`, `/admin/reconciliation-issues`
 * (docs/04 §8.7 for the first two; "reconciliation queue" is named in
 * docs/13-implementation-phases.md's Phase 13 scope but has no route in
 * the 8.7 table — `GET /admin/reconciliation-issues` fills that gap
 * under the same `orders:read`-adjacent OPERATIONS+ gate the rest of
 * this controller uses).
 */
@Controller('admin')
@UseGuards(AuthGuard, AuthorizationGuard)
export class AdminOperationsController {
  constructor(
    @Inject(AdminQueryRepository) private readonly admin: AdminQueryRepository,
    @Inject(NotificationRepository) private readonly notifications: NotificationRepository,
    @Inject(NotificationDispatchService) private readonly dispatch: NotificationDispatchService,
    @Inject(ReconciliationIssueRepository)
    private readonly reconciliation: ReconciliationIssueRepository,
  ) {}

  @Get('deliveries')
  @Permissions('delivery:read')
  @HttpCode(200)
  async listDeliveries(
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = parseLimit(limitRaw);
    const page = await this.admin.listDeliveries({ status }, { cursor, limit });
    return okPage(
      page.items.map((d) => ({
        id: d.id,
        orderId: d.orderId,
        provider: d.provider,
        status: d.status,
        courierName: d.courierName,
        failureReason: d.failureReason,
        attemptCount: d.attemptCount,
        createdAt: d.createdAt,
      })),
      {
        nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
        hasMore: page.hasMore,
        limit: limit ?? 20,
      },
    );
  }

  @Get('notifications')
  @Permissions('delivery:read')
  @HttpCode(200)
  async listNotifications(
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = parseLimit(limitRaw);
    const page = await this.admin.listNotifications({ status }, { cursor, limit });
    return okPage(
      page.items.map((n) => ({
        id: n.id,
        type: n.type,
        channel: n.channel,
        recipientType: n.recipientType,
        status: n.status,
        attempts: n.attempts,
        lastError: n.lastError,
        createdAt: n.createdAt,
      })),
      {
        nextCursor: page.hasMore ? (page.items.at(-1)?.id ?? null) : null,
        hasMore: page.hasMore,
        limit: limit ?? 20,
      },
    );
  }

  /** Idempotent — re-attempting a SENT notification just re-sends (docs/04 §8.7: "Idempotent"); there is no separate "already sent" guard because a deliberate manual retry of a delivered notification is a legitimate admin action, not a bug. */
  @Post('notifications/:id/retry')
  @Permissions('delivery:read')
  @HttpCode(200)
  async retryNotification(@Param('id') id: string) {
    const notification = await this.notifications.findById(id);
    if (!notification) {
      throw new NotFoundError('Notification not found.');
    }
    if (notification.channel === 'IN_APP') {
      throw new ValidationError('IN_APP notifications have no external send step to retry.');
    }
    await this.dispatch.attemptSend(id);
    return ok({ status: 'ok' });
  }

  @Get('reconciliation-issues')
  @Permissions('payments:reconcile')
  @HttpCode(200)
  async listReconciliationIssues() {
    const issues = await this.reconciliation.listOpen();
    return ok(
      issues.map((i) => ({
        id: i.id,
        entityType: i.entityType,
        entityId: i.entityId,
        issueType: i.issueType,
        severity: i.severity,
        status: i.status,
        detectedAt: i.detectedAt,
      })),
    );
  }
}
