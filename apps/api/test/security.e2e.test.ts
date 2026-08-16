import { randomUUID } from 'node:crypto';
import type { Response as SupertestResponse } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { mutate, get, registerAndLogin, type RegisteredUser } from './support/register-and-login.js';

/**
 * Phase 18 — Security hardening. Regression tests for the concrete
 * gaps `SECURITY_AUDIT.md` names: security headers, the explicit body
 * limit, the rate-limit gaps on password/reset, staff otp/verify, and
 * public checkout/quote, and docs/09-security.md §15.5's "mark an
 * unpaid order paid via any API" attack (the one named scenario with
 * no prior dedicated test — see SECURITY_AUDIT.md's coverage table).
 */
describe('Security hardening (Phase 18, e2e)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  async function setUpRestaurant(
    owner: RegisteredUser,
  ): Promise<{ slug: string; restaurantId: string; itemId: string }> {
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
      .send({ categoryId: category.body.data.id, name: 'Thali', priceMinor: '20000' })
      .expect(201);

    return { slug, restaurantId, itemId: item.body.data.id as string };
  }

  // ── security headers (docs/09-security.md §15.7) ──────────────────────

  it('every response carries CSP, HSTS, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy', async () => {
    ctx = await createTestApp();
    const res = await get(ctx, '/health').expect(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['permissions-policy']).toBe('geolocation=(self), camera=(), microphone=()');
  });

  // ── explicit body limit (docs/09-security.md §15.4: "1 MB JSON body limit") ─

  it('rejects a JSON body over 1 MB (413), not an unbounded parse', async () => {
    ctx = await createTestApp();
    const oversized = { padding: 'x'.repeat(1024 * 1024 + 1) };
    const res = await mutate(ctx, 'post', '/api/v1/auth/register').send(oversized);
    expect(res.status).toBe(413);
  });

  // ── docs/09-security.md §15.5: "mark an unpaid order paid via any API" ──

  it('an order can never be marked PLACED without a real provider-verified capture — a forged providerPaymentId 502s and the order stays PENDING_PAYMENT', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, itemId } = await setUpRestaurant(owner);

    const cartRes = await mutate(ctx, 'post', '/api/v1/public/carts')
      .send({ restaurantSlug: slug, items: [{ itemId, quantity: 1, unitPriceMinorAtAdd: '20000' }] })
      .expect(201);
    const checkoutRes = await mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId: cartRes.body.data.cartId,
        guestToken: cartRes.body.data.guestToken,
        customer: { name: 'Asha Customer', phone: '+919876500099' },
        deliveryAddress: { line1: '1 MG Road', city: 'Bengaluru', postalCode: '560001' },
      })
      .expect(200);
    const { orderNumber, accessToken } = checkoutRes.body.data;

    // Never simulated a capture on the mock provider — this order genuinely has no paid state anywhere.
    expect(ctx.db.orders.find((o) => o.orderNumber === orderNumber)!.status).toBe('PENDING_PAYMENT');

    // An attacker who never paid tries several fabricated provider payment ids.
    for (const fakeId of ['mock_pay_forged1', 'mock_pay_forged2', randomUUID()]) {
      const res = await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/verify-payment`)
        .send({ token: accessToken, providerPaymentId: fakeId });
      expect(res.status).toBe(502); // fetched from the provider, never trusted from the client — no fake id resolves.
    }

    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(ctx.db.payments.find((p) => p.orderId === order.id)!.status).not.toBe('CAPTURED');

    // The order never appears as paid/tracked-as-placed via the public tracking endpoint either.
    const tracking = await get(ctx, `/api/v1/public/orders/${orderNumber}?token=${accessToken}`);
    expect(tracking.body.data.status).toBe('PENDING_PAYMENT');
  });

  // ── rate-limit gaps closed this phase ──────────────────────────────────

  it('POST /auth/password/reset is rate limited (was previously unlimited — token brute-force)', async () => {
    ctx = await createTestApp();
    let last: SupertestResponse | undefined;
    for (let i = 0; i < 11; i++) {
      last = await mutate(ctx, 'post', '/api/v1/auth/password/reset').send({
        token: `guess-${i}`,
        newPassword: 'correct-horse-battery-staple',
      });
    }
    expect(last!.status).toBe(429);
    expect(last!.headers['retry-after']).toBeTruthy();
  });

  it('POST /auth/otp/verify (staff) is rate limited per identifier (was previously unlimited — code brute-force)', async () => {
    ctx = await createTestApp();
    let last: SupertestResponse | undefined;
    for (let i = 0; i < 11; i++) {
      last = await mutate(ctx, 'post', '/api/v1/auth/otp/verify').send({
        identifier: 'target@spiceroute.test',
        purpose: 'EMAIL_VERIFICATION',
        code: String(100000 + i),
      });
    }
    expect(last!.status).toBe(429);
  });

  it('POST /public/checkout is rate limited (was previously unlimited — unauthenticated, creates payment intents)', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, itemId } = await setUpRestaurant(owner);

    let last: SupertestResponse | undefined;
    for (let i = 0; i < 21; i++) {
      const cartRes = await mutate(ctx, 'post', '/api/v1/public/carts').send({
        restaurantSlug: slug,
        items: [{ itemId, quantity: 1, unitPriceMinorAtAdd: '20000' }],
      });
      last = await mutate(ctx, 'post', '/api/v1/public/checkout')
        .set('Idempotency-Key', randomUUID())
        .send({
          cartId: cartRes.body.data.cartId,
          guestToken: cartRes.body.data.guestToken,
          customer: { name: 'Asha Customer', phone: '+919876500098' },
          deliveryAddress: { line1: '1 MG Road', city: 'Bengaluru', postalCode: '560001' },
        });
    }
    expect(last!.status).toBe(429);
  });

  // ── empty JSON body no longer breaks bodyless POST endpoints ──────────
  // Found live (tester report): every no-payload restaurant action
  // (POST .../accept, /reject, POST /auth/logout, etc. — none of these
  // handlers declare a @Body() parameter) sends `Content-Type:
  // application/json` with a genuinely empty body. Fastify's own default
  // JSON parser (fastify 4.28.1's contentTypeParser.js) throws
  // FST_ERR_CTP_EMPTY_JSON_BODY unconditionally on an empty body — a
  // check on the parsed buffer's length, not any header — so the request
  // never reached the handler at all. See empty-json-body.parser.ts.
  it('a bodyless POST with Content-Type: application/json succeeds instead of 400ing as an empty JSON body', async () => {
    ctx = await createTestApp();
    const res = await mutate(ctx, 'post', '/api/v1/auth/logout').set('Content-Type', 'application/json');
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('POST /public/checkout/quote is rate limited (was previously unlimited)', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, itemId } = await setUpRestaurant(owner);

    let last: SupertestResponse | undefined;
    for (let i = 0; i < 61; i++) {
      last = await mutate(ctx, 'post', '/api/v1/public/checkout/quote').send({
        restaurantSlug: slug,
        items: [{ itemId, quantity: 1, unitPriceMinorAtAdd: '20000' }],
      });
    }
    expect(last!.status).toBe(429);
  });
});
