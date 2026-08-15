import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { mutate, registerAndLogin } from './support/register-and-login.js';
import { MockPaymentProvider } from '../src/modules/payments/providers/mock-payment.provider.js';
import { PaymentVerificationService } from '../src/modules/payments/services/payment-verification.service.js';
import { RefundService } from '../src/modules/payments/services/refund.service.js';

/**
 * RefundService's creation guard (docs/03-state-machines.md §7.3:
 * "lock the payment row → sum non-FAILED refunds → reject if sum + new
 * > captured_minor → insert. This is what makes INV-6 hold"). No HTTP
 * endpoint calls this yet (see RefundService's own doc comment for why
 * — the two real triggers need Phase 10's restaurant actions and a
 * future Admin module) — exercised directly here instead.
 */
describe('RefundService (Phase 9)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  async function capturedPayment(itemPriceMinor = '20000') {
    const owner = await registerAndLogin(ctx);
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Spice Route' })
      .expect(201);
    const restaurantId = created.body.data.id as string;
    const slug = created.body.data.slug as string;
    const row = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    row.status = 'ACTIVE';
    row.orderingEnabled = true;
    await mutate(ctx, 'put', '/api/v1/restaurant/hours', owner.cookie)
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAt: '00:00',
          closesAt: '23:59',
        })),
      })
      .expect(200);
    const category = await mutate(ctx, 'post', '/api/v1/restaurant/menu/categories', owner.cookie)
      .send({ name: 'Mains' })
      .expect(201);
    const item = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
      .send({ categoryId: category.body.data.id, name: 'Thali', priceMinor: itemPriceMinor })
      .expect(201);

    const cartRes = await mutate(ctx, 'post', '/api/v1/public/carts')
      .send({
        restaurantSlug: slug,
        items: [{ itemId: item.body.data.id, quantity: 1, unitPriceMinorAtAdd: itemPriceMinor }],
      })
      .expect(201);

    const checkoutRes = await mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId: cartRes.body.data.cartId,
        guestToken: cartRes.body.data.guestToken,
        customer: { name: 'Asha Customer', phone: '+919876543210' },
        deliveryAddress: { line1: 'x', city: 'Bengaluru', postalCode: '560001' },
      })
      .expect(200);

    const mockProvider = ctx.app.get(MockPaymentProvider);
    const payment = ctx.db.payments[0]!;
    const { providerPaymentId } = mockProvider.simulatePaymentOutcome(
      payment.providerOrderId!,
      'CAPTURED',
    );

    const verification = ctx.app.get(PaymentVerificationService);
    await verification.verify(checkoutRes.body.data.orderNumber, providerPaymentId!);

    return { paymentId: payment.id, capturedMinor: BigInt(itemPriceMinor) };
  }

  it('a full refund completes and moves the payment to REFUNDED', async () => {
    ctx = await createTestApp();
    const { paymentId, capturedMinor } = await capturedPayment('20000');
    const refunds = ctx.app.get(RefundService);

    const refund = await refunds.requestRefund({
      paymentId,
      amountMinor: capturedMinor,
      reason: 'Customer requested',
      initiatedByActorType: 'ADMIN',
      idempotencyKey: randomUUID(),
    });

    expect(refund.status).toBe('COMPLETED');
    const payment = ctx.db.payments.find((p) => p.id === paymentId)!;
    expect(payment.status).toBe('REFUNDED');
    expect(payment.refundedMinor).toBe(capturedMinor);
  });

  it('a partial refund moves the payment to PARTIALLY_REFUNDED, not REFUNDED', async () => {
    ctx = await createTestApp();
    const { paymentId } = await capturedPayment('20000');
    const refunds = ctx.app.get(RefundService);

    await refunds.requestRefund({
      paymentId,
      amountMinor: 5000n,
      reason: 'Goodwill credit',
      initiatedByActorType: 'ADMIN',
      idempotencyKey: randomUUID(),
    });

    const payment = ctx.db.payments.find((p) => p.id === paymentId)!;
    expect(payment.status).toBe('PARTIALLY_REFUNDED');
    expect(payment.refundedMinor).toBe(5000n);
  });

  it('INV-6: rejects a refund that would push the total refunded above the captured amount', async () => {
    ctx = await createTestApp();
    const { paymentId } = await capturedPayment('20000');
    const refunds = ctx.app.get(RefundService);

    await refunds.requestRefund({
      paymentId,
      amountMinor: 15000n,
      reason: 'First partial refund',
      initiatedByActorType: 'ADMIN',
      idempotencyKey: randomUUID(),
    });

    await expect(
      refunds.requestRefund({
        paymentId,
        amountMinor: 10000n, // 15000 + 10000 > 20000 captured
        reason: 'Second refund attempt',
        initiatedByActorType: 'ADMIN',
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'CONFLICT' });

    // The rejected attempt never touched the payment or created a row.
    const payment = ctx.db.payments.find((p) => p.id === paymentId)!;
    expect(payment.refundedMinor).toBe(15000n);
    expect(ctx.db.refunds.filter((r) => r.paymentId === paymentId)).toHaveLength(1);
  });

  it('replaying the same (paymentId, idempotencyKey) returns the original refund, never a second one', async () => {
    ctx = await createTestApp();
    const { paymentId } = await capturedPayment('20000');
    const refunds = ctx.app.get(RefundService);
    const idempotencyKey = randomUUID();

    const first = await refunds.requestRefund({
      paymentId,
      amountMinor: 5000n,
      reason: 'Goodwill credit',
      initiatedByActorType: 'ADMIN',
      idempotencyKey,
    });
    const second = await refunds.requestRefund({
      paymentId,
      amountMinor: 5000n,
      reason: 'Goodwill credit',
      initiatedByActorType: 'ADMIN',
      idempotencyKey,
    });

    expect(second.id).toBe(first.id);
    expect(ctx.db.refunds.filter((r) => r.paymentId === paymentId)).toHaveLength(1);
    expect(ctx.db.payments.find((p) => p.id === paymentId)!.refundedMinor).toBe(5000n); // not double-applied
  });

  // docs/09-security.md §15.5: "submit two identical refunds concurrently"
  // — genuinely concurrent this time (Promise.all), not the sequential
  // replay above. Phase 18 gap: the sequential test alone doesn't prove
  // the race is actually closed by a real lock/constraint rather than
  // by accident of single-threaded JS never interleaving two awaited
  // calls.
  it('Phase 18: two genuinely concurrent requests with the same (paymentId, idempotencyKey) still produce exactly one refund', async () => {
    ctx = await createTestApp();
    const { paymentId } = await capturedPayment('20000');
    const refunds = ctx.app.get(RefundService);
    const idempotencyKey = randomUUID();

    const [first, second] = await Promise.all([
      refunds.requestRefund({
        paymentId,
        amountMinor: 5000n,
        reason: 'Goodwill credit',
        initiatedByActorType: 'ADMIN',
        idempotencyKey,
      }),
      refunds.requestRefund({
        paymentId,
        amountMinor: 5000n,
        reason: 'Goodwill credit',
        initiatedByActorType: 'ADMIN',
        idempotencyKey,
      }),
    ]);

    expect(first.id).toBe(second.id);
    expect(ctx.db.refunds.filter((r) => r.paymentId === paymentId)).toHaveLength(1);
    expect(ctx.db.payments.find((p) => p.id === paymentId)!.refundedMinor).toBe(5000n);
  });

  it('a refund exactly equal to the remaining captured amount succeeds (boundary, not off-by-one)', async () => {
    ctx = await createTestApp();
    const { paymentId } = await capturedPayment('20000');
    const refunds = ctx.app.get(RefundService);

    await refunds.requestRefund({
      paymentId,
      amountMinor: 12000n,
      reason: 'partial',
      initiatedByActorType: 'ADMIN',
      idempotencyKey: randomUUID(),
    });
    const second = await refunds.requestRefund({
      paymentId,
      amountMinor: 8000n, // exactly the remainder
      reason: 'remainder',
      initiatedByActorType: 'ADMIN',
      idempotencyKey: randomUUID(),
    });

    expect(second.status).toBe('COMPLETED');
    const payment = ctx.db.payments.find((p) => p.id === paymentId)!;
    expect(payment.status).toBe('REFUNDED');
    expect(payment.refundedMinor).toBe(20000n);
  });
});
