import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import {
  mutate,
  get,
  registerAndLogin,
  type RegisteredUser,
} from './support/register-and-login.js';

/**
 * Phase 15 — the full reviews suite from docs/14-acceptance-criteria.md:
 * eligibility from delivered orders, one review per order under
 * concurrency, XSS-safe storage, restaurant cannot hide/edit reviews,
 * rating aggregates reconcile with published rows, and no customer
 * contact details in the public display.
 */
describe('Reviews (Phase 15, e2e)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  async function setUpRestaurant(
    owner: RegisteredUser,
  ): Promise<{ slug: string; restaurantId: string; categoryId: string }> {
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

    return { slug, restaurantId, categoryId: category.body.data.id as string };
  }

  async function createItem(owner: RegisteredUser, categoryId: string, priceMinor: string) {
    const res = await mutate(ctx, 'post', '/api/v1/restaurant/menu/items', owner.cookie)
      .send({ categoryId, name: 'Masala Dosa', priceMinor })
      .expect(201);
    return res.body.data as { id: string; priceMinor: string };
  }

  async function openCart(slug: string, itemId: string, priceMinor: string) {
    const res = await mutate(ctx, 'post', '/api/v1/public/carts')
      .send({
        restaurantSlug: slug,
        items: [{ itemId, quantity: 1, unitPriceMinorAtAdd: priceMinor }],
      })
      .expect(201);
    return {
      cartId: res.body.data.cartId as string,
      guestToken: res.body.data.guestToken as string,
    };
  }

  /** Full setup through a real DELIVERED order — status flipped directly, same shortcut every prior phase's test suite uses when DELIVERED itself isn't what's being tested. */
  async function fullSetupWithDeliveredOrder(phone = '+919876543210') {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, restaurantId, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, '10000');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);

    const checkoutRes = await mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId,
        guestToken,
        customer: { name: 'Asha Customer', phone },
        deliveryAddress: { line1: '221B Brigade Road', city: 'Bengaluru', postalCode: '560001' },
      })
      .expect(200);
    const { orderNumber, accessToken } = checkoutRes.body.data;
    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    order.status = 'DELIVERED';
    order.deliveredAt = new Date();

    return { owner, slug, restaurantId, item, orderNumber, accessToken, order };
  }

  function reviewRequest(orderNumber: string, token: string, rating: number, body?: string) {
    return mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/review`).send({
      token,
      rating,
      ...(body !== undefined ? { body } : {}),
    });
  }

  // ── BR-117: eligibility from delivered orders ────────────────────────

  it('only a customer with a DELIVERED order for that restaurant can review it', async () => {
    const { orderNumber, accessToken } = await fullSetupWithDeliveredOrder();
    const res = await reviewRequest(orderNumber, accessToken, 5, 'Great food!').expect(201);
    expect(res.body.data.rating).toBe(5);
    expect(res.body.data.status).toBe('PUBLISHED');
  });

  it('rejects a review for an order that has not been delivered yet', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, '10000');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const checkoutRes = await mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId,
        guestToken,
        customer: { name: 'Asha Customer', phone: '+919876543210' },
        deliveryAddress: { line1: '221B Brigade Road', city: 'Bengaluru', postalCode: '560001' },
      })
      .expect(200);
    const { orderNumber, accessToken } = checkoutRes.body.data; // status is PENDING_PAYMENT

    const res = await reviewRequest(orderNumber, accessToken, 5);
    expect(res.status).toBe(409);
  });

  it('rejects a review with the wrong access token identically to a nonexistent order (no leak)', async () => {
    const { orderNumber } = await fullSetupWithDeliveredOrder();
    const res = await reviewRequest(orderNumber, 'wrong-token', 5);
    expect(res.status).toBe(404);
  });

  // ── BR-118 / "one review per order under concurrency" ────────────────

  it('one review per order, enforced even under concurrent submission', async () => {
    const { orderNumber, accessToken } = await fullSetupWithDeliveredOrder();

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => reviewRequest(orderNumber, accessToken, (i % 5) + 1)),
    );
    const succeeded = results.filter((r) => r.status === 201);
    expect(succeeded.length).toBeGreaterThanOrEqual(1);

    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    const reviewsForOrder = ctx.db.reviews.filter((r) => r.orderId === order.id);
    expect(reviewsForOrder).toHaveLength(1);
  });

  it('a second review attempt for an already-reviewed order is rejected', async () => {
    const { orderNumber, accessToken } = await fullSetupWithDeliveredOrder();
    await reviewRequest(orderNumber, accessToken, 4).expect(201);
    const second = await reviewRequest(orderNumber, accessToken, 2);
    expect(second.status).toBe(409);
  });

  // ── BR-120: XSS-safe storage ──────────────────────────────────────────

  it('stores an XSS-shaped payload verbatim (rendering safety is the frontend/React escaping boundary)', async () => {
    const { orderNumber, accessToken } = await fullSetupWithDeliveredOrder();
    const payload = '<script>alert(1)</script>Actually pretty good';
    const res = await reviewRequest(orderNumber, accessToken, 3, payload).expect(201);

    const stored = ctx.db.reviews.find((r) => r.id === res.body.data.id)!;
    expect(stored.body).toBe(payload);
  });

  // ── BR-121: restaurant cannot hide or edit reviews ───────────────────

  it('a restaurant cannot edit, hide, or delete a review — no such endpoint exists', async () => {
    const { owner, orderNumber, accessToken } = await fullSetupWithDeliveredOrder();
    const reviewRes = await reviewRequest(orderNumber, accessToken, 1, 'Not great').expect(201);
    const reviewId = reviewRes.body.data.id as string;

    // The only restaurant-facing review routes are GET (list) and POST
    // .../response — there is no PATCH/DELETE on a review at all.
    await mutate(ctx, 'patch', `/api/v1/restaurant/reviews/${reviewId}`, owner.cookie).send({
      rating: 5,
    });
    await mutate(ctx, 'delete', `/api/v1/restaurant/reviews/${reviewId}`, owner.cookie);

    const stored = ctx.db.reviews.find((r) => r.id === reviewId)!;
    expect(stored.rating).toBe(1);
    expect(stored.status).toBe('PUBLISHED');
  });

  it('a restaurant can post exactly one response to a review', async () => {
    const { owner, orderNumber, accessToken } = await fullSetupWithDeliveredOrder();
    const reviewRes = await reviewRequest(orderNumber, accessToken, 4, 'Good').expect(201);
    const reviewId = reviewRes.body.data.id as string;

    await mutate(ctx, 'post', `/api/v1/restaurant/reviews/${reviewId}/response`, owner.cookie)
      .send({ body: 'Thank you for your feedback!' })
      .expect(201);

    const second = await mutate(
      ctx,
      'post',
      `/api/v1/restaurant/reviews/${reviewId}/response`,
      owner.cookie,
    ).send({ body: 'Again!' });
    expect(second.status).toBe(409);
  });

  // ── BR-123: aggregates reconcile with published rows ─────────────────

  it('rating aggregates reconcile with published rows, and moderating a review out of PUBLISHED updates them', async () => {
    const { restaurantId, orderNumber, accessToken } =
      await fullSetupWithDeliveredOrder('+919876543211');
    await reviewRequest(orderNumber, accessToken, 5).expect(201);

    const restaurant = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    expect(restaurant.ratingCount).toBe(1);
    expect(restaurant.ratingAvg).not.toBeNull();

    // Admin moderates it to HIDDEN — the aggregate must drop back to zero
    // published reviews, reconciling with the actual source rows.
    const admin = await registerAndLogin(ctx, { email: 'super@direct-order.test' });
    ctx.db.adminUsers.push({
      id: randomUUID(),
      userId: admin.userId,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    ctx.db.sessions.find((s) => s.userId === admin.userId)!.mfaVerifiedAt = new Date();
    ctx.db.users.find((u) => u.id === admin.userId)!.mfaEnabledAt = new Date();

    const review = ctx.db.reviews.find(
      (r) => r.orderId === ctx.db.orders.find((o) => o.orderNumber === orderNumber)!.id,
    )!;
    await mutate(ctx, 'post', `/api/v1/admin/reviews/${review.id}/moderate`, admin.cookie)
      .send({ status: 'HIDDEN', reason: 'Suspected fake review' })
      .expect(200);

    const restaurantAfter = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    expect(restaurantAfter.ratingCount).toBe(0);
    expect(restaurantAfter.ratingAvg).toBeNull();
  });

  // ── BR-124: no customer contact details in public display ────────────

  it('the public review list exposes only a first name and never phone/email/address', async () => {
    const { slug, orderNumber, accessToken } = await fullSetupWithDeliveredOrder();
    await reviewRequest(orderNumber, accessToken, 5, 'Loved it').expect(201);

    const res = await get(ctx, `/api/v1/public/restaurants/${slug}/reviews`).expect(200);
    expect(res.body.data).toHaveLength(1);
    const review = res.body.data[0];
    expect(review.authorFirstName).toBe('Asha');
    expect(review.rating).toBe(5);
    expect(review.body).toBe('Loved it');
    expect(JSON.stringify(review)).not.toContain('9876543210');
    expect(JSON.stringify(review)).not.toContain('@');
  });

  it('the public review list only shows PUBLISHED reviews, not a moderated-away one', async () => {
    const { slug, orderNumber, accessToken } = await fullSetupWithDeliveredOrder();
    const reviewRes = await reviewRequest(orderNumber, accessToken, 1, 'Bad').expect(201);
    ctx.db.reviews.find((r) => r.id === reviewRes.body.data.id)!.status = 'HIDDEN';

    const res = await get(ctx, `/api/v1/public/restaurants/${slug}/reviews`).expect(200);
    expect(res.body.data).toHaveLength(0);
  });
});
