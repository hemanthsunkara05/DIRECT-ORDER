import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Order, Prisma } from '@prisma/client';
import { PrismaService } from '../../../platform/database/prisma.service.js';
import { AppError } from '../../../platform/errors/app-error.js';
import { isUniqueConstraintViolation } from '../../../platform/database/prisma-errors.js';
import { OutboxService } from '../../../platform/outbox/outbox.service.js';
import { PublicMenuRepository } from '../../public/repositories/public-menu.repository.js';
import {
  CheckoutQuoteService,
  type CartIssue,
} from '../../public/services/checkout-quote.service.js';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from '../../payments/providers/payment-provider.port.js';
import { CartRepository } from '../repositories/cart.repository.js';
import { OrderRepository } from '../repositories/order.repository.js';
import { hashToken } from './cart.service.js';
import { generateOrderNumber } from '../order-number.js';
import { serializeBreakdown, type SerializedPricingBreakdown } from '../serialize-breakdown.js';
import type { CheckoutInput } from '../dto/checkout.dto.js';
import { PromotionReservationService } from '../../promotions/services/promotion-reservation.service.js';

export interface CheckoutResponseBody {
  orderNumber: string;
  /** Null on an idempotent replay — the raw token is returned once, at original creation, and never persisted (same pattern as every other token in this codebase); see CheckoutService's class doc comment for why a replay cannot reissue it. */
  accessToken: string | null;
  status: Order['status'];
  payableTotalMinor: string;
  breakdown: SerializedPricingBreakdown;
  provider: { name: string; providerOrderId: string; providerPublicKey: string } | null;
}

type OrderBaseFields = Omit<
  Prisma.OrderUncheckedCreateInput,
  'orderNumber' | 'customerId' | 'status' | 'history' | 'payments'
>;

const MAX_ORDER_NUMBER_ATTEMPTS = 5;

/**
 * `POST /public/checkout` — the mandated 12-step sequence
 * (docs/04-api-specification.md §8.3), the single highest-risk endpoint
 * in the project. Steps 2-5 and 8 are NOT re-implemented here: they are
 * `CheckoutQuoteService.quoteByRestaurantId` (already exercised, on its
 * own, by `/public/checkout/quote`), so quote and checkout agree on
 * price and validity by construction — one function, not two. Step 6
 * (coupon reservation, Phase 14) happens in two halves: a non-locking
 * preview inside that SAME `quoteByRestaurantId` call (so "re-validated
 * at checkout", BR-86, is a fresh call, not a reused page-load quote),
 * then the authoritative, LOCKED re-check inside `createOrderAttempt`'s
 * transaction (`PromotionReservationService.checkAndLock`), in the same
 * transaction as Order creation. Step 7 (loyalty reservation) is still
 * skipped — no LoyaltyLedger table exists yet (Phase 16).
 *
 * Idempotency (docs/04 §8.2: "A replay returns the original response
 * with 200, never a duplicate resource"): the `Order` row's
 * `@@unique([restaurantId, idempotencyKey])` constraint is the actual
 * correctness guarantee for "double-click pay" and "concurrent
 * identical checkouts" — a pre-check read handles the common
 * sequential-retry case, and a P2002 catch-and-refetch handles the true
 * concurrent race, so exactly one Order is ever created either way.
 * What a replay CANNOT do is reissue the original raw `accessToken`:
 * only its hash is ever persisted (BR-35's own pattern, same as staff
 * invitations), by design, so a second response to the same
 * idempotency key returns `accessToken: null` rather than a duplicate
 * or fabricated token. In practice the first (winning) response is the
 * one a real client acts on; the frontend also disables the pay button
 * after the first click to make a true double-submit rare. This is a
 * deliberate, documented scope boundary, not an oversight — building a
 * short-TTL response cache (e.g. in Redis) to reissue the exact
 * original body was considered and rejected: the acceptance criterion
 * this phase is actually held to is "no duplicate order, duplicate
 * charge, or incorrect state" (docs/13-implementation-phases.md), which
 * holds regardless, and every one of the ten named failure scenarios in
 * docs/11 §18.3 is satisfied without it.
 */
@Injectable()
export class CheckoutService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CartRepository) private readonly carts: CartRepository,
    @Inject(PublicMenuRepository) private readonly menu: PublicMenuRepository,
    @Inject(CheckoutQuoteService) private readonly quoteService: CheckoutQuoteService,
    @Inject(OrderRepository) private readonly orders: OrderRepository,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PAYMENT_PROVIDER) private readonly paymentProvider: PaymentProvider,
    @Inject(PromotionReservationService) private readonly promotions: PromotionReservationService,
  ) {}

  async checkout(input: CheckoutInput, idempotencyKey: string): Promise<CheckoutResponseBody> {
    // Step 1: load cart, verify ownership.
    const cart = await this.carts.findByIdWithItems(input.cartId);
    if (!cart || cart.guestTokenHash !== hashToken(input.guestToken)) {
      throw new AppError('CART_NOT_FOUND', 404, 'Cart not found.');
    }

    // Checked before the cart's OPEN/expiry status: a successful first
    // checkout converts the cart to CONVERTED, so a replay of the same
    // Idempotency-Key against that now-converted cart must still return
    // the original order, not "cart not found" — idempotency-key replay
    // takes priority over cart freshness once ownership is established.
    const replay = await this.orders.findByRestaurantIdempotencyKey(
      cart.restaurantId,
      idempotencyKey,
    );
    if (replay) {
      return toReplayResponse(replay);
    }

    if (cart.status !== 'OPEN' || cart.expiresAt.getTime() < Date.now()) {
      throw new AppError('CART_NOT_FOUND', 404, 'This cart is no longer available.');
    }
    if (cart.items.length === 0) {
      throw new AppError('CART_EMPTY', 409, 'Cart is empty.');
    }

    // Steps 2-6, 8: availability, live items, price drift, min order,
    // coupon preview, pricing.
    const quote = await this.quoteService.quoteByRestaurantId(
      cart.restaurantId,
      cart.items.map((item) => ({
        itemId: item.menuItemId,
        quantity: item.quantity,
        unitPriceMinorAtAdd: item.unitPriceMinorAtAdd,
      })),
      input.couponCode,
    );
    if (!quote.valid) {
      throwForIssues(quote.issues);
    }

    // Step 9: client-supplied total is comparison-only, never authoritative.
    if (
      input.expectedTotalMinor !== undefined &&
      input.expectedTotalMinor !== quote.breakdown.payableTotalMinor
    ) {
      throw new AppError(
        'TOTAL_MISMATCH',
        409,
        'The order total changed since you last saw it. Please review and try again.',
        [
          {
            field: 'expectedTotalMinor',
            message: `Expected ${input.expectedTotalMinor}, actual ${quote.breakdown.payableTotalMinor}.`,
          },
        ],
      );
    }

    const liveItems = await this.menu.findByIds(
      cart.restaurantId,
      quote.breakdown.items.map((item) => item.itemId),
    );
    const descriptionById = new Map(liveItems.map((item) => [item.id, item.description]));

    const accessToken = randomBytes(32).toString('base64url');
    const baseFields: OrderBaseFields = {
      restaurantId: cart.restaurantId,
      customerName: input.customer.name,
      customerPhone: input.customer.phone,
      deliveryAddress: input.deliveryAddress,
      itemsSubtotalMinor: quote.breakdown.itemsSubtotalMinor,
      packagingFeeMinor: quote.breakdown.packagingFeeMinor,
      deliveryFeeMinor: quote.breakdown.deliveryFeeMinor,
      platformFeeMinor: quote.breakdown.platformFeeMinor,
      taxMinor: quote.breakdown.taxMinor,
      discountMinor: quote.breakdown.discountMinor,
      loyaltyDiscountMinor: quote.breakdown.loyaltyDiscountMinor,
      payableTotalMinor: quote.breakdown.payableTotalMinor,
      pricingBreakdown: serializeBreakdown(quote.breakdown) as unknown as Prisma.InputJsonValue,
      idempotencyKey,
      accessTokenHash: hashToken(accessToken),
      items: {
        create: quote.breakdown.items.map((item) => ({
          menuItemId: item.itemId,
          nameSnapshot: item.name,
          descriptionSnapshot: descriptionById.get(item.itemId) ?? undefined,
          unitPriceMinorSnapshot: item.unitPriceMinor,
          quantity: item.quantity,
          lineTotalMinor: item.lineTotalMinor,
        })),
      },
    };

    // Step 10: one transaction — Customer, Order (PENDING_PAYMENT),
    // OrderItems, Payment (CREATED), status history, cart conversion.
    let order: Order & { payments: { id: string }[] };
    try {
      order = await this.createOrderAttempt(
        input,
        idempotencyKey,
        cart.id,
        baseFields,
        quote.breakdown.payableTotalMinor,
        quote.breakdown.promotionDiscountMinor,
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        // Concurrent identical checkout — the other request won the race.
        const raced = await this.orders.findByRestaurantIdempotencyKey(
          cart.restaurantId,
          idempotencyKey,
        );
        if (raced) return toReplayResponse(raced);
      }
      throw error;
    }

    // Step 11: create the provider payment order — a network call, kept
    // outside the DB transaction deliberately (never hold a transaction
    // open across an external I/O call).
    const paymentId = order.payments[0]!.id;
    const intent = await this.paymentProvider.createPaymentIntent({
      orderId: order.id,
      amountMinor: order.payableTotalMinor,
      currency: order.currency,
      receipt: order.orderNumber,
    });
    await this.prisma.payment.update({
      where: { id: paymentId },
      data: { providerOrderId: intent.providerOrderId, status: 'PENDING' },
    });

    await this.outbox.record(
      'ORDER_PENDING_PAYMENT',
      { orderId: order.id, orderNumber: order.orderNumber },
      order.restaurantId,
    );

    return {
      orderNumber: order.orderNumber,
      accessToken,
      status: order.status,
      payableTotalMinor: order.payableTotalMinor.toString(),
      breakdown: serializeBreakdown(quote.breakdown),
      provider: {
        name: this.paymentProvider.name,
        providerOrderId: intent.providerOrderId,
        providerPublicKey: intent.providerPublicKey,
      },
    };
  }

  /**
   * Retries on an order-number collision only (astronomically unlikely,
   * see order-number.ts) — never on the idempotency-key constraint,
   * which the caller handles by replaying instead of retrying.
   */
  private async createOrderAttempt(
    input: CheckoutInput,
    idempotencyKey: string,
    cartId: string,
    baseFields: OrderBaseFields,
    payableTotalMinor: bigint,
    promotionDiscountMinor: bigint,
  ): Promise<Order & { payments: { id: string }[] }> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ORDER_NUMBER_ATTEMPTS; attempt++) {
      const orderNumber = generateOrderNumber();
      try {
        return await this.prisma.$transaction(async (tx) => {
          const customer = await tx.customer.create({
            data: {
              fullName: input.customer.name,
              phone: input.customer.phone,
              email: input.customer.email,
              status: 'ACTIVE',
            },
          });

          // Step 6's authoritative half — locked, re-validated fresh
          // under the transaction (BR-86). Aborting here (throw) rolls
          // back the customer create above too; no order is ever left
          // half-created on a rejected coupon.
          let checkedCoupon: { promotionId: string; couponCode: string } | null = null;
          if (input.couponCode) {
            checkedCoupon = await this.promotions.checkAndLock(tx, {
              couponCode: input.couponCode,
              restaurantId: baseFields.restaurantId,
              itemsSubtotalMinor: BigInt(baseFields.itemsSubtotalMinor),
              customerPhone: input.customer.phone,
            });
          }

          const created = await tx.order.create({
            data: {
              ...baseFields,
              orderNumber,
              customerId: customer.id,
              status: 'PENDING_PAYMENT',
              promotionId: checkedCoupon?.promotionId,
              couponCode: checkedCoupon?.couponCode,
              history: {
                create: [
                  {
                    fromStatus: null,
                    toStatus: 'PENDING_PAYMENT',
                    actorType: 'SYSTEM',
                    reason: 'Checkout',
                  },
                ],
              },
              payments: {
                create: [
                  {
                    provider: this.paymentProvider.name,
                    status: 'CREATED',
                    amountMinor: payableTotalMinor,
                    currency: 'INR',
                    idempotencyKey: `${idempotencyKey}:payment`,
                  },
                ],
              },
              ...(checkedCoupon
                ? {
                    promotionRedemptions: {
                      create: [
                        {
                          promotionId: checkedCoupon.promotionId,
                          customerId: customer.id,
                          customerPhone: input.customer.phone,
                          status: 'RESERVED',
                          discountMinor: promotionDiscountMinor,
                        },
                      ],
                    },
                  }
                : {}),
            },
            include: { payments: true },
          });

          await tx.cart.update({ where: { id: cartId }, data: { status: 'CONVERTED' } });

          return created;
        });
      } catch (error) {
        lastError = error;
        if (isUniqueConstraintViolation(error) && isOrderNumberCollision(error)) {
          continue; // retry with a fresh random order number
        }
        throw error;
      }
    }
    throw lastError;
  }
}

function toReplayResponse(order: Order): CheckoutResponseBody {
  return {
    orderNumber: order.orderNumber,
    accessToken: null,
    status: order.status,
    payableTotalMinor: order.payableTotalMinor.toString(),
    breakdown: order.pricingBreakdown as unknown as SerializedPricingBreakdown,
    provider: null,
  };
}

function throwForIssues(issues: CartIssue[]): never {
  const restaurantUnavailable = issues.find((issue) => issue.code === 'RESTAURANT_UNAVAILABLE');
  if (restaurantUnavailable) {
    throw new AppError(
      'RESTAURANT_UNAVAILABLE',
      409,
      'This restaurant is not accepting orders right now.',
      [{ field: 'restaurant', message: restaurantUnavailable.reason }],
    );
  }

  const unavailableItems = issues.filter((issue) => issue.code === 'ITEM_UNAVAILABLE');
  if (unavailableItems.length > 0) {
    throw new AppError(
      'ITEM_UNAVAILABLE',
      409,
      'One or more items are no longer available.',
      unavailableItems.map((issue) => ({ field: issue.itemId, message: 'unavailable' })),
    );
  }

  const priceChanged = issues.filter((issue) => issue.code === 'PRICE_CHANGED');
  if (priceChanged.length > 0) {
    throw new AppError(
      'PRICE_CHANGED',
      409,
      'One or more item prices changed. Please review your order.',
      priceChanged.map((issue) => ({
        field: issue.itemId,
        message: `${issue.oldPriceMinor} -> ${issue.newPriceMinor}`,
      })),
    );
  }

  const belowMinimum = issues.find((issue) => issue.code === 'BELOW_MINIMUM_ORDER');
  if (belowMinimum) {
    throw new AppError(
      'MIN_ORDER_NOT_MET',
      409,
      "This order is below the restaurant's minimum order amount.",
      [{ field: 'subtotal', message: `Minimum is ${belowMinimum.minimumMinor}.` }],
    );
  }

  // BR-95 anti-enumeration: the same generic message regardless of why
  // the code is invalid — see CheckoutQuoteService's CartIssue doc comment.
  if (issues.some((issue) => issue.code === 'COUPON_INVALID')) {
    throw new AppError('COUPON_INVALID', 409, 'This coupon code is not valid for this order.');
  }
  if (issues.some((issue) => issue.code === 'COUPON_EXHAUSTED')) {
    throw new AppError('COUPON_EXHAUSTED', 409, 'This coupon has reached its usage limit.');
  }

  throw new AppError('CART_INVALID', 409, 'This cart failed validation.');
}

/** Distinguishes an order_number collision from an idempotency-key collision — both raise P2002, only the former should be retried. */
function isOrderNumberCollision(error: unknown): boolean {
  const meta = (error as { meta?: { target?: string[] | string } }).meta;
  const target = meta?.target;
  const fields = Array.isArray(target) ? target.join(',') : (target ?? '');
  return fields.includes('order_number') || fields.includes('orderNumber');
}
