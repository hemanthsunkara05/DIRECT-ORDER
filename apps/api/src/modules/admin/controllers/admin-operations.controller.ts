import { Controller, Get, HttpCode, Inject, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { Permissions } from '../../../platform/authorization/permissions.decorator.js';
import { AuthorizationGuard } from '../../../platform/authorization/authorization.guard.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { AdminQueryRepository } from '../repositories/admin-query.repository.js';
import { NotificationRepository } from '../../notifications/repositories/notification.repository.js';
import { NotificationDispatchService } from '../../notifications/services/notification-dispatch.service.js';
import { ReconciliationIssueRepository } from '../../payments/repositories/reconciliation-issue.repository.js';

/**
 * docs/07-events-and-jobs.md's "queue monitoring thresholds" table,
 * carried over as literally as this codebase's actual architecture
 * allows — there is no real BullMQ queue to sample a "depth" from
 * (every job in this codebase is an in-process `setInterval` poller,
 * not a queue; see PHASE_REPORTS.md's Phase 19 entry for the honest
 * accounting of that gap). `outbox_events` PENDING rows are this
 * codebase's actual equivalent of the webhooks/payments queues (the
 * outbox relay drives both); `notifications` PENDING/DEAD_LETTERED
 * map directly to the doc's own named metric and DLQ thresholds.
 */
const OUTBOX_BACKLOG_WARNING = 50;
const OUTBOX_BACKLOG_CRITICAL = 200;
const NOTIFICATION_BACKLOG_WARNING = 500;
const NOTIFICATION_BACKLOG_CRITICAL = 2000;
const DEAD_LETTER_WARNING = 1;
const DEAD_LETTER_CRITICAL = 10;
const OLDEST_AGE_WARNING_SECONDS = 2 * 60;
const OLDEST_AGE_CRITICAL_SECONDS = 10 * 60;

type HealthStatus = 'ok' | 'warning' | 'critical';

function statusFor(count: number, warning: number, critical: number): HealthStatus {
  if (count >= critical) return 'critical';
  if (count >= warning) return 'warning';
  return 'ok';
}

function worstOf(...statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes('critical')) return 'critical';
  if (statuses.includes('warning')) return 'warning';
  return 'ok';
}

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
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * Phase 19 "queue monitoring and alerting" — see this file's own
   * threshold constants for the mapping from docs/07's queue-depth
   * table to what this codebase's in-process pollers actually expose.
   * Read-only, cheap indexed counts on small tables — the same
   * "operational visibility, not a live scan of a big table"
   * reasoning `AdminOverviewController`'s `restaurantsByStatus`/
   * `activeAdmins` already established.
   */
  @Get('system-health')
  @Permissions('payments:reconcile')
  @HttpCode(200)
  async systemHealth() {
    const now = Date.now();
    const [
      outboxPending,
      oldestPendingOutbox,
      notificationPending,
      oldestPendingNotification,
      notificationDeadLettered,
      openReconciliationIssues,
    ] = await Promise.all([
      this.prisma.outboxEvent.count({ where: { status: 'PENDING' } }),
      this.prisma.outboxEvent.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.notification.count({ where: { status: 'PENDING' } }),
      this.prisma.notification.findFirst({
        where: { status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.notification.count({ where: { status: 'DEAD_LETTERED' } }),
      this.reconciliation.listOpen(),
    ]);

    const outboxOldestAgeSeconds = oldestPendingOutbox
      ? Math.floor((now - oldestPendingOutbox.createdAt.getTime()) / 1000)
      : null;
    const notificationOldestAgeSeconds = oldestPendingNotification
      ? Math.floor((now - oldestPendingNotification.createdAt.getTime()) / 1000)
      : null;

    const outboxStatus = worstOf(
      statusFor(outboxPending, OUTBOX_BACKLOG_WARNING, OUTBOX_BACKLOG_CRITICAL),
      statusFor(
        outboxOldestAgeSeconds ?? 0,
        OLDEST_AGE_WARNING_SECONDS,
        OLDEST_AGE_CRITICAL_SECONDS,
      ),
    );
    const notificationStatus = worstOf(
      statusFor(notificationPending, NOTIFICATION_BACKLOG_WARNING, NOTIFICATION_BACKLOG_CRITICAL),
      statusFor(notificationDeadLettered, DEAD_LETTER_WARNING, DEAD_LETTER_CRITICAL),
      statusFor(
        notificationOldestAgeSeconds ?? 0,
        OLDEST_AGE_WARNING_SECONDS,
        OLDEST_AGE_CRITICAL_SECONDS,
      ),
    );

    const bySeverity: Record<string, number> = {};
    for (const issue of openReconciliationIssues) {
      bySeverity[issue.severity] = (bySeverity[issue.severity] ?? 0) + 1;
    }

    return ok({
      overall: worstOf(
        outboxStatus,
        notificationStatus,
        openReconciliationIssues.length > 0 ? 'warning' : 'ok',
      ),
      outbox: { pending: outboxPending, oldestPendingAgeSeconds: outboxOldestAgeSeconds, status: outboxStatus },
      notifications: {
        pending: notificationPending,
        deadLettered: notificationDeadLettered,
        oldestPendingAgeSeconds: notificationOldestAgeSeconds,
        status: notificationStatus,
      },
      reconciliationIssues: { open: openReconciliationIssues.length, bySeverity },
    });
  }

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
