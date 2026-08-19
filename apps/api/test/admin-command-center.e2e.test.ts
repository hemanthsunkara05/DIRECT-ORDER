import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { AdminRole } from '@prisma/client';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import {
  get,
  mutate,
  registerAndLogin,
  type RegisteredUser,
} from './support/register-and-login.js';
import { TotpService } from '../src/modules/identity/services/totp.service.js';
import { MockPaymentProvider } from '../src/modules/payments/providers/mock-payment.provider.js';
import { PaymentVerificationService } from '../src/modules/payments/services/payment-verification.service.js';
import { AnalyticsRollupService } from '../src/modules/analytics/services/analytics-rollup.service.js';

/**
 * Phase 23a — admin command center (real data only), admin order
 * detail, and the admin-authorized upload endpoint. Mirrors
 * admin.e2e.test.ts's own `registerAdmin`/`setUpRestaurantWithPlacedOrder`
 * pattern (each admin e2e file keeps its own local copy — same
 * convention `restaurant-orders.e2e.test.ts`'s local `addMembership`
 * already established).
 */
describe('Admin command center, order detail, and admin upload (Phase 23a, e2e)', () => {
  let ctx: TestApp;
  const totp = new TotpService();

  afterEach(async () => {
    await ctx.app.close();
  });

  interface AdminPrincipal extends RegisteredUser {
    adminUserId: string;
    role: AdminRole;
  }

  async function registerAdmin(role: AdminRole, email?: string): Promise<AdminPrincipal> {
    const owner = await registerAndLogin(ctx, {
      email: email ?? `admin-${randomUUID()}@direct-order.test`,
    });
    const adminUserId = randomUUID();
    ctx.db.adminUsers.push({
      id: adminUserId,
      userId: owner.userId,
      role,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const enrollRes = await mutate(ctx, 'post', '/api/v1/auth/mfa/enroll', owner.cookie)
      .send({})
      .expect(200);
    const secret = enrollRes.body.data.secret as string;
    const code = totp.generate(secret);
    await mutate(ctx, 'post', '/api/v1/auth/mfa/enroll/confirm', owner.cookie)
      .send({ code })
      .expect(200);

    return { ...owner, adminUserId, role };
  }

  async function setUpRestaurantWithPlacedOrder(itemPriceMinor = '20000') {
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Spice Route' })
      .expect(201);
    const restaurantId = created.body.data.id as string;
    const slug = created.body.data.slug as string;
    const row = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    row.status = 'ACTIVE';
    row.orderingEnabled = true;
    ctx.db.restaurantAddresses.push({
      id: randomUUID(),
      restaurantId,
      line1: '123 MG Road',
      line2: null,
      locality: null,
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      latitude: null,
      longitude: null,
      landmark: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
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
        deliveryAddress: {
          line1: 'Flat 4B, Palm Residency',
          city: 'Bengaluru',
          postalCode: '560034',
        },
      })
      .expect(200);

    const mockPayment = ctx.app.get(MockPaymentProvider);
    const payment = ctx.db.payments.at(-1)!;
    const { providerPaymentId } = await mockPayment.simulatePaymentOutcome(
      payment.providerOrderId!,
      'CAPTURED',
    );
    const verification = ctx.app.get(PaymentVerificationService);
    await verification.verify(checkoutRes.body.data.orderNumber, providerPaymentId!);

    const order = ctx.db.orders.find((o) => o.orderNumber === checkoutRes.body.data.orderNumber)!;
    return { owner, restaurantId, slug, order };
  }

  // ── GET /admin/overview/command-center ──────────────────────────────

  it('returns the full KPI/funnel/alerts/topRestaurants shape for an admin holding analytics:platform', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { order, restaurantId } = await setUpRestaurantWithPlacedOrder();
    // Rollup today's row so the KPI section isn't all zeros.
    await ctx.app.get(AnalyticsRollupService).rollupPlatformDay(
      new Date().toISOString().slice(0, 10),
    );

    const res = await get(ctx, '/api/v1/admin/overview/command-center', admin.cookie).expect(200);
    const body = res.body.data;

    expect(body.kpis).toBeDefined();
    expect(typeof body.kpis.ordersToday).toBe('number');
    expect(typeof body.kpis.gmvTodayMinor).toBe('string');
    expect(typeof body.kpis.restaurantsLive).toBe('number');
    expect(body.kpis.restaurantsLive).toBeGreaterThanOrEqual(1);

    expect(body.funnel.PLACED).toBeGreaterThanOrEqual(1);
    expect(body.funnel.ACCEPTED).toBe(0);

    expect(Array.isArray(body.alerts.stuckOrders)).toBe(true);
    expect(Array.isArray(body.alerts.overdueApprovals)).toBe(true);
    // Order was just placed — not yet 45 minutes old, so it must NOT appear as stuck.
    expect(body.alerts.stuckOrders.some((o: { id: string }) => o.id === order.id)).toBe(false);

    expect(Array.isArray(body.topRestaurants)).toBe(true);
    expect(
      body.topRestaurants.some((r: { restaurantId: string }) => r.restaurantId === restaurantId),
    ).toBe(true);
  });

  it('flags an order stuck past the 45-minute threshold, and stops flagging it once it moves on', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { order } = await setUpRestaurantWithPlacedOrder();

    const row = ctx.db.orders.find((o) => o.id === order.id)!;
    row.updatedAt = new Date(Date.now() - 46 * 60_000);

    const res = await get(ctx, '/api/v1/admin/overview/command-center', admin.cookie).expect(200);
    expect(
      res.body.data.alerts.stuckOrders.some((o: { id: string }) => o.id === order.id),
    ).toBe(true);
  });

  it('flags a restaurant PENDING_APPROVAL for more than 24 hours', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const restaurantRow = await ctx.db.prisma.restaurant.create({
      data: { slug: `overdue-${randomUUID()}`, name: 'Overdue Diner', status: 'PENDING_APPROVAL' },
    });
    const stored = ctx.db.restaurants.find((r) => r.id === restaurantRow.id)!;
    stored.submittedAt = new Date(Date.now() - 25 * 60 * 60_000);

    const res = await get(ctx, '/api/v1/admin/overview/command-center', admin.cookie).expect(200);
    expect(
      res.body.data.alerts.overdueApprovals.some(
        (r: { id: string }) => r.id === restaurantRow.id,
      ),
    ).toBe(true);
  });

  it('an admin without analytics:platform (SUPPORT) gets 403; a restaurant owner (no AdminUser row) gets 403', async () => {
    ctx = await createTestApp();
    const support = await registerAdmin('SUPPORT');
    const { owner } = await setUpRestaurantWithPlacedOrder();

    await get(ctx, '/api/v1/admin/overview/command-center', support.cookie).expect(403);
    await get(ctx, '/api/v1/admin/overview/command-center', owner.cookie).expect(403);
  });

  // ── GET /admin/orders/:id/detail ─────────────────────────────────────

  it('returns full order detail cross-tenant, including a null delivery panel for a not-yet-dispatched order', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { order } = await setUpRestaurantWithPlacedOrder();

    const res = await get(ctx, `/api/v1/admin/orders/${order.id}/detail`, admin.cookie).expect(200);
    expect(res.body.data.id).toBe(order.id);
    expect(res.body.data.items.length).toBeGreaterThan(0);
    expect(res.body.data.payment).not.toBeNull();
    expect(res.body.data.delivery).toBeNull();
  });

  it('404s for a nonexistent order id', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');

    await get(ctx, `/api/v1/admin/orders/${randomUUID()}/detail`, admin.cookie).expect(404);
  });

  // ── Admin-authorized upload ──────────────────────────────────────────

  it('an admin holding restaurant:admin_edit can presign an upload for any restaurant', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { restaurantId } = await setUpRestaurantWithPlacedOrder();

    const res = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/uploads/presign`,
      admin.cookie,
    )
      .send({ contentType: 'image/jpeg', sizeBytes: 1024 })
      .expect(200);

    expect(res.body.data.key).toContain(`restaurants/${restaurantId}/`);
    expect(res.body.data.uploadUrl).toBeDefined();
  });

  it('an admin without restaurant:admin_edit (SUPPORT) gets 403 on the admin upload endpoint', async () => {
    ctx = await createTestApp();
    const support = await registerAdmin('SUPPORT');
    const { restaurantId } = await setUpRestaurantWithPlacedOrder();

    await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/uploads/presign`,
      support.cookie,
    )
      .send({ contentType: 'image/jpeg', sizeBytes: 1024 })
      .expect(403);
  });

  it('a restaurant owner (no AdminUser row) gets 403 on the admin upload endpoint, even for their own restaurant', async () => {
    ctx = await createTestApp();
    const { owner, restaurantId } = await setUpRestaurantWithPlacedOrder();

    await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/uploads/presign`,
      owner.cookie,
    )
      .send({ contentType: 'image/jpeg', sizeBytes: 1024 })
      .expect(403);
  });
});
