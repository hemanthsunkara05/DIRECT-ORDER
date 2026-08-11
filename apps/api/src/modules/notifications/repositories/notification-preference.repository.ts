import { Inject, Injectable } from '@nestjs/common';
import type {
  NotificationCategory,
  NotificationChannel,
  NotificationPreference,
  NotificationRecipientType,
} from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

@Injectable()
export class NotificationPreferenceRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async listForRecipient(
    recipientType: NotificationRecipientType,
    recipientId: string,
  ): Promise<NotificationPreference[]> {
    return this.prisma.notificationPreference.findMany({ where: { recipientType, recipientId } });
  }

  async findOne(
    recipientType: NotificationRecipientType,
    recipientId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
  ): Promise<NotificationPreference | null> {
    return this.prisma.notificationPreference.findUnique({
      where: {
        recipientType_recipientId_category_channel: {
          recipientType,
          recipientId,
          category,
          channel,
        },
      },
    });
  }

  /** Upsert — a recipient toggling the same (category, channel) twice just updates the one row, never creates a second. */
  async upsert(
    recipientType: NotificationRecipientType,
    recipientId: string,
    category: NotificationCategory,
    channel: NotificationChannel,
    enabled: boolean,
  ): Promise<NotificationPreference> {
    return this.prisma.notificationPreference.upsert({
      where: {
        recipientType_recipientId_category_channel: {
          recipientType,
          recipientId,
          category,
          channel,
        },
      },
      create: { recipientType, recipientId, category, channel, enabled },
      update: { enabled },
    });
  }
}
