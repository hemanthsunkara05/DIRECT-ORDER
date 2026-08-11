import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import type { NotificationCategory, NotificationChannel, User } from '@prisma/client';
import { ok, okPage } from '../../../platform/http/response-envelope.js';
import { NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { AuthGuard } from '../../identity/guards/auth.guard.js';
import { CurrentUser } from '../../identity/decorators/current-user.decorator.js';
import { NotificationRepository } from '../repositories/notification.repository.js';
import { NotificationPreferenceService } from '../services/notification-preference.service.js';

const CATEGORIES: NotificationCategory[] = ['SECURITY', 'TRANSACTIONAL', 'ACCOUNT', 'MARKETING'];
const CHANNELS: NotificationChannel[] = ['IN_APP', 'SMS', 'WHATSAPP', 'EMAIL'];
const NON_DISABLEABLE = new Set<NotificationCategory>(['SECURITY', 'TRANSACTIONAL']);

const UpdatePreferenceDto = z.object({
  category: z.enum(['SECURITY', 'TRANSACTIONAL', 'ACCOUNT', 'MARKETING']),
  channel: z.enum(['IN_APP', 'SMS', 'WHATSAPP', 'EMAIL']),
  enabled: z.boolean(),
});

/**
 * `/me/notifications*`, `/me/notification-preferences`
 * (docs/04-api-specification.md §8.7, Phase 12). Every recipient here
 * is `RESTAURANT_USER` (`user.id`) — the authenticated `User`/`Session`
 * system already built in Phase 3 for restaurant staff. There is
 * deliberately no CUSTOMER branch: guest checkout is still the pilot
 * default (AMB-2, unchanged since Phase 9) — no registered customer
 * session exists to authenticate `/me/*` against. Customer-recipient
 * `Notification` rows still get created and sent (SMS/email) by
 * `NotificationDispatchService`; they are simply not readable through
 * this HTTP surface yet. See docs/05-authorization-matrix.md: "Notification
 * — recipient_type/recipient_id match the principal" — enforced here by
 * always deriving `recipientId` from the authenticated user, never a
 * client-supplied id (BR-148).
 */
@Controller()
@UseGuards(AuthGuard)
export class NotificationCenterController {
  constructor(
    @Inject(NotificationRepository) private readonly notifications: NotificationRepository,
    @Inject(NotificationPreferenceService)
    private readonly preferences: NotificationPreferenceService,
  ) {}

  @Get('me/notifications')
  @HttpCode(200)
  async list(
    @CurrentUser() user: User,
    @Query('cursor') cursor?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    if (limitRaw !== undefined && (!Number.isFinite(limit) || limit! < 1)) {
      throw new ValidationError('limit must be a positive integer.');
    }
    const rows = await this.notifications.listForRecipient('RESTAURANT_USER', user.id, {
      cursor,
      limit,
    });
    const effectiveLimit = limit ?? 20;
    const hasMore = rows.length > effectiveLimit;
    const items = hasMore ? rows.slice(0, effectiveLimit) : rows;
    return okPage(
      items.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        body: n.body,
        readAt: n.readAt,
        createdAt: n.createdAt,
      })),
      {
        nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
        hasMore,
        limit: effectiveLimit,
      },
    );
  }

  @Get('me/notifications/unread-count')
  @HttpCode(200)
  async unreadCount(@CurrentUser() user: User) {
    const count = await this.notifications.countUnread('RESTAURANT_USER', user.id);
    return ok({ count });
  }

  @Post('me/notifications/:id/read')
  @HttpCode(200)
  async markRead(@CurrentUser() user: User, @Param('id') id: string) {
    const notification = await this.notifications.findByIdForRecipient(
      id,
      'RESTAURANT_USER',
      user.id,
    );
    if (!notification) {
      throw new NotFoundError('Notification not found.');
    }
    if (!notification.readAt) {
      await this.notifications.markRead(id);
    }
    return ok({ read: true });
  }

  @Post('me/notifications/read-all')
  @HttpCode(200)
  async markAllRead(@CurrentUser() user: User) {
    const count = await this.notifications.markAllRead('RESTAURANT_USER', user.id);
    return ok({ updated: count });
  }

  @Get('me/notification-preferences')
  @HttpCode(200)
  async listPreferences(@CurrentUser() user: User) {
    const rows = await this.preferences.list('RESTAURANT_USER', user.id);
    const byKey = new Map(rows.map((r) => [`${r.category}:${r.channel}`, r.enabled]));
    const grid = CATEGORIES.flatMap((category) =>
      CHANNELS.map((channel) => ({
        category,
        channel,
        enabled: byKey.get(`${category}:${channel}`) ?? category !== 'MARKETING',
        disableable: !NON_DISABLEABLE.has(category),
      })),
    );
    return ok({ preferences: grid });
  }

  @Patch('me/notification-preferences')
  @HttpCode(200)
  async updatePreference(@CurrentUser() user: User, @Body() body: unknown) {
    const input = UpdatePreferenceDto.parse(body);
    const updated = await this.preferences.update(
      'RESTAURANT_USER',
      user.id,
      input.category,
      input.channel,
      input.enabled,
    );
    return ok({ category: updated.category, channel: updated.channel, enabled: updated.enabled });
  }
}
