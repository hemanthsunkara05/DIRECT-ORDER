import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { ok } from '../../../platform/http/response-envelope.js';
import { NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { OrderTrackingService } from '../services/order-tracking.service.js';
import { PaymentVerificationService } from '../../payments/services/payment-verification.service.js';
import { hashToken } from '../services/cart.service.js';
import { OrderRepository } from '../repositories/order.repository.js';
import { MockPaymentProvider } from '../../payments/providers/mock-payment.provider.js';
import { SubmitReviewDto } from '../../reviews/dto/submit-review.dto.js';
import { ReviewService } from '../../reviews/services/review.service.js';

const VerifyPaymentDto = z.object({
  token: z.string().min(1),
  providerPaymentId: z.string().min(1).optional(),
});
const SimulatePaymentDto = z.object({
  token: z.string().min(1),
  outcome: z.enum(['CAPTURED', 'FAILED']),
});

/**
 * `/public/orders/*` (docs/04-api-specification.md §8.3). Guest access
 * is proved by `?token=`, verified identically to
 * `OrderTrackingService` — see that service's doc comment for why a
 * session-based branch is out of scope this phase (AMB-2).
 */
@Controller('public/orders')
export class OrderTrackingController {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(OrderTrackingService) private readonly tracking: OrderTrackingService,
    @Inject(PaymentVerificationService) private readonly verification: PaymentVerificationService,
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(MockPaymentProvider) private readonly mockProvider: MockPaymentProvider,
    @Inject(ReviewService) private readonly reviews: ReviewService,
  ) {}

  @Get(':orderNumber')
  async get(@Param('orderNumber') orderNumber: string, @Query('token') token?: string) {
    if (!token) {
      throw new NotFoundError('Order not found.');
    }
    const view = await this.tracking.getByOrderNumber(orderNumber, token);
    return ok(view);
  }

  @Post(':orderNumber/verify-payment')
  @HttpCode(200)
  async verifyPayment(@Param('orderNumber') orderNumber: string, @Body() body: unknown) {
    const input = VerifyPaymentDto.parse(body);
    await this.assertOwnership(orderNumber, input.token);
    const result = await this.verification.verify(orderNumber, input.providerPaymentId);
    return ok({ paymentStatus: result.payment.status, orderStatus: result.orderStatus });
  }

  /**
   * Dev/test-only: stands in for "the customer completed Razorpay
   * Checkout" — see MockPaymentProvider's own doc comment. Returns 404
   * (not just an error code) when `PAYMENT_PROVIDER=razorpay` so this
   * endpoint is indistinguishable from not existing in that
   * configuration, rather than a route that predictably always fails.
   */
  @Post(':orderNumber/simulate-payment')
  @HttpCode(200)
  async simulatePayment(@Param('orderNumber') orderNumber: string, @Body() body: unknown) {
    if (this.env.PAYMENT_PROVIDER !== 'mock') {
      throw new NotFoundError();
    }
    const input = SimulatePaymentDto.parse(body);
    await this.assertOwnership(orderNumber, input.token);

    const order = await this.orders.findByOrderNumber(orderNumber);
    const payment = order?.payments[0];
    if (!order || !payment?.providerOrderId) {
      throw new ValidationError('This order has no in-progress payment intent to simulate.');
    }

    const result = this.mockProvider.simulatePaymentOutcome(payment.providerOrderId, input.outcome);
    return ok({ providerPaymentId: result.providerPaymentId });
  }

  /**
   * `POST /public/orders/:orderNumber/review` — Phase 15. Not
   * `POST /me/reviews` (docs/04-api-specification.md §8.4) — see
   * `ReviewService`'s own doc comment for why the guest access token
   * is this codebase's only real customer identity today (AMB-2).
   */
  @Post(':orderNumber/review')
  @HttpCode(201)
  async submitReview(@Param('orderNumber') orderNumber: string, @Body() body: unknown) {
    const input = SubmitReviewDto.parse(body);
    const review = await this.reviews.submit(orderNumber, input.token, {
      rating: input.rating,
      body: input.body,
    });
    return ok({ id: review.id, rating: review.rating, status: review.status });
  }

  private async assertOwnership(orderNumber: string, token: string | undefined): Promise<void> {
    if (!token) throw new NotFoundError('Order not found.');
    const order = await this.orders.findByOrderNumber(orderNumber);
    if (!order || order.accessTokenHash !== hashToken(token)) {
      throw new NotFoundError('Order not found.');
    }
  }
}
