import { Inject, Injectable } from '@nestjs/common';
import type { Refund, RefundStatus } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';

export interface CreateRefundInput {
  paymentId: string;
  orderId: string;
  amountMinor: bigint;
  reason: string;
  initiatedByActorType: string;
  initiatedByActorId?: string;
  idempotencyKey: string;
}

@Injectable()
export class RefundRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async create(input: CreateRefundInput): Promise<Refund> {
    return this.prisma.refund.create({
      data: {
        paymentId: input.paymentId,
        orderId: input.orderId,
        amountMinor: input.amountMinor,
        reason: input.reason,
        status: 'REQUESTED',
        initiatedByActorType: input.initiatedByActorType,
        initiatedByActorId: input.initiatedByActorId,
        idempotencyKey: input.idempotencyKey,
      },
    });
  }

  async findByPaymentAndIdempotencyKey(
    paymentId: string,
    idempotencyKey: string,
  ): Promise<Refund | null> {
    return this.prisma.refund.findFirst({ where: { paymentId, idempotencyKey } });
  }

  /** Non-FAILED refunds against this payment — the set BR-49's `sum <= captured_minor` guard sums over. */
  async findActiveByPaymentId(paymentId: string): Promise<Refund[]> {
    return this.prisma.refund.findMany({
      where: { paymentId, status: { not: 'FAILED' } },
    });
  }

  async update(
    refundId: string,
    data: Partial<{
      status: RefundStatus;
      providerRefundId: string;
      completedAt: Date;
      failureReason: string;
    }>,
  ): Promise<Refund> {
    return this.prisma.refund.update({ where: { id: refundId }, data });
  }
}
