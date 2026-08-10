import { Inject, Injectable } from '@nestjs/common';
import type { Delivery, DeliveryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { isUniqueConstraintViolation } from '../../../platform/database/prisma-errors.js';

export interface CreateDeliveryInput {
  orderId: string;
  provider: string;
  pickupAddress: unknown;
  dropoffAddress: unknown;
  idempotencyKey: string;
}

export interface UpdateDeliveryInput {
  status?: DeliveryStatus;
  providerDeliveryId?: string;
  trackingUrl?: string;
  courierName?: string;
  courierPhone?: string;
  quotedFeeMinor?: bigint;
  actualFeeMinor?: bigint;
  estimatedPickupAt?: Date;
  estimatedDeliveryAt?: Date;
  pickedUpAt?: Date;
  deliveredAt?: Date;
  cancellationReason?: string;
  failureReason?: string;
  attemptCount?: { increment: number };
}

/**
 * `@@unique([orderId])` (docs/02-database-schema.md §6.4) is the
 * primary defence against a duplicate dispatch — `createIfNotExists`
 * mirrors `WebhookEventRepository.createIfNotExists`'s P2002-catch-and-
 * return-null shape exactly, so "mark ready" twice resolves to "row
 * already exists, do nothing" rather than a thrown error the caller has
 * to specifically know to swallow.
 *
 * No dedicated tenant-scoped lookup here: a Delivery has no
 * `restaurantId` column of its own, and the one caller that needs the
 * restaurant delivery view (`RestaurantOrderService.detail()`) already
 * reaches it for free through `OrderRepository.findByIdForRestaurant`'s
 * own `include: { delivery: true }` — that method's existing tenant
 * check (via `assertTenantResourceFound`) already covers it, so
 * duplicating a second, parallel tenant-scoped path here would be dead
 * code.
 */
@Injectable()
export class DeliveryRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async createIfNotExists(input: CreateDeliveryInput): Promise<Delivery | null> {
    try {
      return await this.prisma.delivery.create({
        data: {
          orderId: input.orderId,
          provider: input.provider,
          status: 'PENDING_CREATION',
          pickupAddress: input.pickupAddress as Prisma.InputJsonValue,
          dropoffAddress: input.dropoffAddress as Prisma.InputJsonValue,
          idempotencyKey: input.idempotencyKey,
        },
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        return null;
      }
      throw error;
    }
  }

  async findByOrderId(orderId: string): Promise<Delivery | null> {
    return this.prisma.delivery.findUnique({ where: { orderId } });
  }

  async findByProviderDeliveryId(
    provider: string,
    providerDeliveryId: string,
  ): Promise<Delivery | null> {
    return this.prisma.delivery.findFirst({ where: { provider, providerDeliveryId } });
  }

  async update(id: string, data: UpdateDeliveryInput): Promise<Delivery> {
    return this.prisma.delivery.update({ where: { id }, data });
  }
}
