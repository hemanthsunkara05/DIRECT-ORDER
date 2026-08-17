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
import { OutboxService } from '../src/platform/outbox/outbox.service.js';
import { RestaurantStateService } from '../src/modules/admin/services/restaurant-state.service.js';

/**
 * Phase 13 — admin panel. docs/14-acceptance-criteria.md's named
 * scenarios. "Admin moves a DELIVERED order to PREPARING → 409" (docs/05
 * §9.4) has no literal endpoint to drive (the only admin order action is
 * `cancel`, not an arbitrary transition) — tested here as "admin cannot
 * cancel a DELIVERED order", the practical equivalent given the actual
 * API surface: it proves the same thing (`OrderStateService`'s graph
 * has no outbound edge from DELIVERED at all, so ANY admin-driven move
 * away from it 409s).
 */
describe('Admin panel (Phase 13, e2e)', () => {
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

  /** Mirrors the Rajahmundry outreach script: a Restaurant owned only by the unclaimed-listing placeholder account. */
  async function seedUnclaimedListing(slug: string, name: string, phone: string | null = null) {
    const placeholder = await ctx.db.prisma.user.create({
      data: {
        email: 'unclaimed-listings@direct-order.local',
        fullName: 'Unclaimed Listing',
        status: 'ACTIVE',
      },
    });
    const restaurant = await ctx.db.prisma.restaurant.create({
      data: { slug, name, phone, status: 'ACTIVE', onboardingStatus: 'NOT_STARTED', orderingEnabled: false },
    });
    await ctx.db.prisma.restaurantStaff.create({
      data: { restaurantId: restaurant.id, userId: placeholder.id, role: 'OWNER' },
    });
    return restaurant;
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

  // ── Non-admin denial ──────────────────────────────────────────────

  it('a regular authenticated user (no AdminUser row) receives 403 on every admin route', async () => {
    ctx = await createTestApp();
    const user = await registerAndLogin(ctx);

    await get(ctx, '/api/v1/admin/restaurants', user.cookie).expect(403);
    await get(ctx, '/api/v1/admin/orders', user.cookie).expect(403);
    await get(ctx, '/api/v1/admin/users', user.cookie).expect(403);
    await get(ctx, '/api/v1/admin/audit-logs', user.cookie).expect(403);
  });

  it('a restaurant owner cannot reach admin APIs (403, not treated as any admin role)', async () => {
    ctx = await createTestApp();
    const { owner } = await setUpRestaurantWithPlacedOrder();

    await get(ctx, '/api/v1/admin/restaurants', owner.cookie).expect(403);
  });

  // ── MFA enforcement ────────────────────────────────────────────────

  it('an AdminUser who never enrolled MFA is denied even with the correct role', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    ctx.db.adminUsers.push({
      id: randomUUID(),
      userId: owner.userId,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await get(ctx, '/api/v1/admin/audit-logs', owner.cookie).expect(403);
  });

  it('an AdminUser who enrolled MFA but has not verified it for THIS session is denied', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    ctx.db.adminUsers.push({
      id: randomUUID(),
      userId: owner.userId,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await mutate(ctx, 'post', '/api/v1/auth/mfa/enroll', owner.cookie).send({}).expect(200);
    // Enrolled (secret stored) but never confirmed — mfaEnabledAt is still null.

    await get(ctx, '/api/v1/admin/audit-logs', owner.cookie).expect(403);
  });

  it('an admin with MFA enrolled and verified for this session is granted access — MFA enforced at the API, not only the UI', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('SUPER_ADMIN');

    await get(ctx, '/api/v1/admin/audit-logs', admin.cookie).expect(200);
  });

  it('a wrong MFA code is rejected and never marks the session verified', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    ctx.db.adminUsers.push({
      id: randomUUID(),
      userId: owner.userId,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const enrollRes = await mutate(ctx, 'post', '/api/v1/auth/mfa/enroll', owner.cookie)
      .send({})
      .expect(200);
    await mutate(ctx, 'post', '/api/v1/auth/mfa/enroll/confirm', owner.cookie)
      .send({ code: '000000' })
      .expect(422);
    void enrollRes;

    await get(ctx, '/api/v1/admin/audit-logs', owner.cookie).expect(403);
  });

  // ── Restaurant lifecycle ───────────────────────────────────────────

  it('approve/suspend/reinstate walk the restaurant state machine and are each audited', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Fresh Kitchen' })
      .expect(201);
    const restaurantId = created.body.data.id as string;
    ctx.db.restaurants.find((r) => r.id === restaurantId)!.status = 'PENDING_APPROVAL';

    const approveRes = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/approve`,
      admin.cookie,
    )
      .send({})
      .expect(200);
    expect(approveRes.body.data.status).toBe('ACTIVE');

    const suspendRes = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/suspend`,
      admin.cookie,
    )
      .send({ reason: 'Food safety complaint under review' })
      .expect(200);
    expect(suspendRes.body.data.status).toBe('SUSPENDED');

    const reinstateRes = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/reinstate`,
      admin.cookie,
    )
      .send({})
      .expect(200);
    expect(reinstateRes.body.data.status).toBe('ACTIVE');

    // Filtered to ADMIN-actor entries — restaurant creation itself
    // (Phase 5) already records its own RESTAURANT_CREATED entry
    // against the same entityId, from the owner, not this admin.
    const actions = ctx.db.auditLogs.filter(
      (a) => a.entityId === restaurantId && a.actorType === 'ADMIN',
    );
    expect(actions.map((a) => a.action)).toEqual([
      'RESTAURANT_ACTIVE',
      'RESTAURANT_SUSPENDED',
      'RESTAURANT_ACTIVE',
    ]);
    expect(actions.every((a) => a.actorType === 'ADMIN' && a.actorId === admin.adminUserId)).toBe(
      true,
    );
    expect(actions[1]!.reason).toBe('Food safety complaint under review');
    expect(actions.every((a) => a.createdAt instanceof Date)).toBe(true);
  });

  it('suspend requires a reason (422)', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { restaurantId } = await setUpRestaurantWithPlacedOrder();

    await mutate(ctx, 'post', `/api/v1/admin/restaurants/${restaurantId}/suspend`, admin.cookie)
      .send({})
      .expect(422);
  });

  it('suspending a restaurant blocks new orders while an in-flight order remains fully fulfillable', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { owner, slug, order } = await setUpRestaurantWithPlacedOrder();
    const restaurantId = order.restaurantId;

    await mutate(ctx, 'post', `/api/v1/admin/restaurants/${restaurantId}/suspend`, admin.cookie)
      .send({ reason: 'Routine compliance check' })
      .expect(200);

    // New order creation is blocked — `isAcceptingOrders()` (Phase 7's
    // one authoritative function) keys off `status`, not a separate
    // flag, so a SUSPENDED restaurant is reported as not-accepting with
    // no other data touched.
    const publicRes = await get(ctx, `/api/v1/public/restaurants/${slug}`).expect(200);
    expect(publicRes.body.data.status).toBe('SUSPENDED');
    expect(publicRes.body.data.availability.accepting).toBe(false);
    expect(publicRes.body.data.availability.reason).toBe('SUSPENDED');

    // The in-flight order is still fully manageable by restaurant staff — never stranded.
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/accept`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/preparing`, owner.cookie)
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    const readyRes = await mutate(
      ctx,
      'post',
      `/api/v1/restaurant/orders/${order.id}/ready`,
      owner.cookie,
    )
      .set('Idempotency-Key', randomUUID())
      .send({})
      .expect(200);
    expect(readyRes.body.data.status).toBe('READY_FOR_PICKUP');
  });

  it('approve on a restaurant not in PENDING_APPROVAL is rejected (409) — the transition graph, not just a status flip', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { restaurantId } = await setUpRestaurantWithPlacedOrder(); // already ACTIVE

    await mutate(ctx, 'post', `/api/v1/admin/restaurants/${restaurantId}/approve`, admin.cookie)
      .send({})
      .expect(409);
  });

  // ── Phase 21a: fast-path restaurant approval ────────────────────────

  it('reject requires a reason (422)', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Fresh Kitchen' })
      .expect(201);
    ctx.db.restaurants.find((r) => r.id === created.body.data.id)!.status = 'PENDING_APPROVAL';

    await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${created.body.data.id}/reject`,
      admin.cookie,
    )
      .send({})
      .expect(422);
  });

  it('reject with a reason over 500 chars is rejected (422)', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Fresh Kitchen' })
      .expect(201);
    ctx.db.restaurants.find((r) => r.id === created.body.data.id)!.status = 'PENDING_APPROVAL';

    await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${created.body.data.id}/reject`,
      admin.cookie,
    )
      .send({ reason: 'x'.repeat(501) })
      .expect(422);
  });

  it('reject from a non-PENDING_APPROVAL state is rejected (409)', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { restaurantId } = await setUpRestaurantWithPlacedOrder(); // already ACTIVE

    await mutate(ctx, 'post', `/api/v1/admin/restaurants/${restaurantId}/reject`, admin.cookie)
      .send({ reason: 'Not applicable' })
      .expect(409);
  });

  it('reject is gated on restaurant:reject: a restaurant owner (no AdminUser row) gets 403, and an admin without the permission (FINANCE-only) also gets 403', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_FINANCE');
    const { owner, restaurantId } = await setUpRestaurantWithPlacedOrder();
    ctx.db.restaurants.find((r) => r.id === restaurantId)!.status = 'PENDING_APPROVAL';

    await mutate(ctx, 'post', `/api/v1/admin/restaurants/${restaurantId}/reject`, owner.cookie)
      .send({ reason: 'not an admin' })
      .expect(403);
    await mutate(ctx, 'post', `/api/v1/admin/restaurants/${restaurantId}/reject`, admin.cookie)
      .send({ reason: 'FINANCE cannot reject' })
      .expect(403);
  });

  it('full lifecycle: submit notifies admins, reject notifies the restaurant with the reason, resubmit clears it, approve notifies again', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const outbox = ctx.app.get(OutboxService);
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Fresh Kitchen' })
      .expect(201);
    const restaurantId = created.body.data.id as string;
    await mutate(ctx, 'patch', '/api/v1/restaurant/profile', owner.cookie)
      .send({
        address: {
          line1: '1 MG Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        },
      })
      .expect(200);

    // Submit -> PENDING_APPROVAL, admins holding restaurant:approve/reject are notified.
    await mutate(ctx, 'post', '/api/v1/restaurant/onboarding/submit', owner.cookie).expect(200);
    await outbox.relayPending();
    const submittedNotice = ctx.db.notifications.find(
      (n) => n.type === 'RESTAURANT_SUBMITTED_FOR_APPROVAL' && n.recipientType === 'ADMIN',
    );
    expect(submittedNotice).toBeDefined();
    expect(submittedNotice!.recipientId).toBe(admin.userId);

    // Reject with a reason.
    await mutate(ctx, 'post', `/api/v1/admin/restaurants/${restaurantId}/reject`, admin.cookie)
      .send({ reason: 'Address could not be verified' })
      .expect(200);
    const rejected = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.decidedAt).not.toBeNull();
    expect(rejected.rejectionReason).toBe('Address could not be verified');

    await outbox.relayPending();
    const rejectedNotice = ctx.db.notifications.find(
      (n) => n.type === 'RESTAURANT_REJECTED' && n.recipientType === 'RESTAURANT_USER',
    );
    expect(rejectedNotice).toBeDefined();
    expect(rejectedNotice!.recipientId).toBe(owner.userId);
    expect(rejectedNotice!.body).toContain('Address could not be verified');

    // Restaurant sees the actual reason via its own profile, not just "REJECTED".
    const profileAfterReject = await get(ctx, '/api/v1/restaurant/profile', owner.cookie).expect(
      200,
    );
    expect(profileAfterReject.body.data.rejectionReason).toBe('Address could not be verified');

    // Resubmit -> PENDING_APPROVAL again, reason cleared.
    const resubmitRes = await mutate(
      ctx,
      'post',
      '/api/v1/restaurant/onboarding/submit',
      owner.cookie,
    ).expect(200);
    expect(resubmitRes.body.data.status).toBe('PENDING_APPROVAL');
    expect(resubmitRes.body.data.rejectionReason).toBeNull();

    // Approve.
    const approveRes = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/approve`,
      admin.cookie,
    )
      .send({})
      .expect(200);
    expect(approveRes.body.data.status).toBe('ACTIVE');
    const approved = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    expect(approved.decidedAt).not.toBeNull();

    await outbox.relayPending();
    const approvedNotice = ctx.db.notifications.find(
      (n) => n.type === 'RESTAURANT_APPROVED' && n.recipientType === 'RESTAURANT_USER',
    );
    expect(approvedNotice).toBeDefined();
    expect(approvedNotice!.recipientId).toBe(owner.userId);
  });

  it('order=oldest sorts PENDING_APPROVAL restaurants by submittedAt ascending; the default (unspecified) order still sorts by createdAt descending, unchanged', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');

    async function createPending(name: string, createdAt: Date, submittedAt: Date) {
      const owner = await registerAndLogin(ctx, {
        email: `${name.toLowerCase()}-${randomUUID()}@spiceroute.test`,
      });
      const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name })
        .expect(201);
      const row = ctx.db.restaurants.find((r) => r.id === created.body.data.id)!;
      row.status = 'PENDING_APPROVAL';
      row.createdAt = createdAt;
      row.submittedAt = submittedAt;
      return row.id;
    }

    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    // Created oldest-to-newest as A, B, C, but SUBMITTED in a different
    // order — a resubmitted restaurant should review by resubmission
    // time, not its original creation time.
    const idA = await createPending('A', new Date(now - 3 * day), new Date(now - 1 * day));
    const idB = await createPending('B', new Date(now - 2 * day), new Date(now - 3 * day));
    const idC = await createPending('C', new Date(now - 1 * day), new Date(now - 2 * day));

    const oldestFirst = await get(
      ctx,
      '/api/v1/admin/restaurants?status=PENDING_APPROVAL&order=oldest',
      admin.cookie,
    ).expect(200);
    expect(oldestFirst.body.data.map((r: { id: string }) => r.id)).toEqual([idB, idC, idA]);

    const defaultOrder = await get(
      ctx,
      '/api/v1/admin/restaurants?status=PENDING_APPROVAL',
      admin.cookie,
    ).expect(200);
    expect(defaultOrder.body.data.map((r: { id: string }) => r.id)).toEqual([idC, idB, idA]);
  });

  it('GET /admin/restaurants/:id/detail returns address, menu summary, and branding; 404 for a nonexistent id', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { restaurantId } = await setUpRestaurantWithPlacedOrder(); // seeds an address + one category/item

    const res = await get(
      ctx,
      `/api/v1/admin/restaurants/${restaurantId}/detail`,
      admin.cookie,
    ).expect(200);
    expect(res.body.data.id).toBe(restaurantId);
    expect(res.body.data.address).toMatchObject({ city: 'Bengaluru', state: 'Karnataka' });
    expect(res.body.data.menuSummary).toEqual({ categoryCount: 1, itemCount: 1 });

    await get(ctx, `/api/v1/admin/restaurants/${randomUUID()}/detail`, admin.cookie).expect(404);
  });

  it('concurrent approve and reject on the same PENDING_APPROVAL restaurant: exactly one wins, the restaurant never ends up in an inconsistent state', async () => {
    ctx = await createTestApp();
    const admin1 = await registerAdmin('ADMIN_OPERATIONS');
    const admin2 = await registerAdmin('ADMIN_OPERATIONS', `admin2-${randomUUID()}@direct-order.test`);
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Fresh Kitchen' })
      .expect(201);
    const restaurantId = created.body.data.id as string;
    ctx.db.restaurants.find((r) => r.id === restaurantId)!.status = 'PENDING_APPROVAL';

    const stateService = ctx.app.get(RestaurantStateService);
    const results = await Promise.allSettled([
      stateService.approve(restaurantId, admin1.adminUserId),
      stateService.reject(restaurantId, admin2.adminUserId, 'Concurrent rejection'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);

    const finalStatus = ctx.db.restaurants.find((r) => r.id === restaurantId)!.status;
    expect(['ACTIVE', 'REJECTED']).toContain(finalStatus);
  });

  it('GET /admin/restaurants/unclaimed lists only outreach-batch previews, never a real restaurant', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    await seedUnclaimedListing('sandhya-s-kitchen', "Sandhya's Kitchen", '8919500575');
    await setUpRestaurantWithPlacedOrder(); // a real, normally-onboarded restaurant

    const res = await get(ctx, '/api/v1/admin/restaurants/unclaimed', admin.cookie).expect(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      slug: 'sandhya-s-kitchen',
      name: "Sandhya's Kitchen",
      phone: '8919500575',
    });
  });

  it('GET /admin/restaurants/unclaimed drops off once claimed', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    await seedUnclaimedListing('sandhya-s-kitchen', "Sandhya's Kitchen");
    const owner = await registerAndLogin(ctx, { email: `claimer-${randomUUID()}@spiceroute.test` });
    await mutate(ctx, 'post', '/api/v1/restaurants/claim', owner.cookie)
      .send({ slug: 'sandhya-s-kitchen' })
      .expect(200);

    const res = await get(ctx, '/api/v1/admin/restaurants/unclaimed', admin.cookie).expect(200);
    expect(res.body.data).toHaveLength(0);
  });

  // ── Order cancellation, refunds ────────────────────────────────────

  it('admin cancel of a paid order triggers exactly one refund, and a second cancel attempt never creates a duplicate', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { order } = await setUpRestaurantWithPlacedOrder('20000');

    const first = await mutate(ctx, 'post', `/api/v1/admin/orders/${order.id}/cancel`, admin.cookie)
      .send({ reason: 'Duplicate order reported by customer' })
      .expect(200);
    expect(first.body.data.status).toBe('CANCELLED');
    expect(first.body.data.applied).toBe(true);
    expect(ctx.db.refunds.filter((r) => r.orderId === order.id)).toHaveLength(1);
    expect(ctx.db.refunds.find((r) => r.orderId === order.id)!.amountMinor).toBe(20000n);

    const second = await mutate(
      ctx,
      'post',
      `/api/v1/admin/orders/${order.id}/cancel`,
      admin.cookie,
    )
      .send({ reason: 'Duplicate order reported by customer' })
      .expect(200);
    expect(second.body.data.applied).toBe(false); // already CANCELLED — idempotent replay, not a new cancellation
    expect(ctx.db.refunds.filter((r) => r.orderId === order.id)).toHaveLength(1); // still exactly one
  }, 30_000); // registerAdmin() + setUpRestaurantWithPlacedOrder() + two cancels is the heaviest combination in this file — comfortably under 30s even under load, per the 80s-for-21-tests timing this file already showed.

  it('cancel requires a reason (422)', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { order } = await setUpRestaurantWithPlacedOrder();

    await mutate(ctx, 'post', `/api/v1/admin/orders/${order.id}/cancel`, admin.cookie)
      .send({})
      .expect(422);
  });

  it('a DELIVERED order cannot be cancelled (409) — no override path exists once delivered', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const { owner, order } = await setUpRestaurantWithPlacedOrder();

    // Walk the order all the way to DELIVERED.
    for (const step of ['accept', 'preparing', 'ready'] as const) {
      await mutate(ctx, 'post', `/api/v1/restaurant/orders/${order.id}/${step}`, owner.cookie)
        .set('Idempotency-Key', randomUUID())
        .send({})
        .expect(200);
    }
    const orderRow = ctx.db.orders.find((o) => o.id === order.id)!;
    orderRow.status = 'DELIVERED'; // delivery webhook-driven in reality (Phase 11); direct here for a focused test

    const res = await mutate(ctx, 'post', `/api/v1/admin/orders/${order.id}/cancel`, admin.cookie)
      .send({ reason: 'Attempting to cancel after delivery' })
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  // ── Users, audit log ───────────────────────────────────────────────

  it('GET /admin/users never returns a password hash or MFA secret', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('SUPPORT');
    await registerAndLogin(ctx);

    const res = await get(ctx, '/api/v1/admin/users', admin.cookie).expect(200);
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain('passwordHash');
    expect(bodyText).not.toContain('mfaSecret');
  });

  it('disabling the last active SUPER_ADMIN is rejected (409) — the platform always retains at least one', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('SUPER_ADMIN');

    const res = await mutate(
      ctx,
      'post',
      `/api/v1/admin/users/${admin.userId}/disable`,
      admin.cookie,
    )
      .send({})
      .expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('disabling a second SUPER_ADMIN succeeds, revokes their sessions, and is audited', async () => {
    ctx = await createTestApp();
    const admin1 = await registerAdmin('SUPER_ADMIN');
    const admin2 = await registerAdmin('SUPER_ADMIN');

    await mutate(ctx, 'post', `/api/v1/admin/users/${admin2.userId}/disable`, admin1.cookie)
      .send({})
      .expect(200);

    expect(ctx.db.users.find((u) => u.id === admin2.userId)!.status).toBe('DISABLED');
    expect(
      ctx.db.sessions.filter((s) => s.userId === admin2.userId).every((s) => s.revokedAt !== null),
    ).toBe(true);
    const auditRow = ctx.db.auditLogs.find(
      (a) => a.action === 'USER_DISABLED' && a.entityId === admin2.userId,
    );
    expect(auditRow).toBeDefined();
    expect(auditRow!.actorId).toBe(admin1.adminUserId);
  });

  it('there is no API path to create, edit, or delete an audit record (404 for every write verb)', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('SUPER_ADMIN');

    await mutate(ctx, 'post', '/api/v1/admin/audit-logs', admin.cookie).send({}).expect(404);
    await mutate(ctx, 'patch', '/api/v1/admin/audit-logs/some-id', admin.cookie)
      .send({})
      .expect(404);
    await mutate(ctx, 'delete', '/api/v1/admin/audit-logs/some-id', admin.cookie).expect(404);
  });

  it('audit log is server-side cursor-paginated and returns entries newest first', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('SUPER_ADMIN');
    // Three independent restaurants, each suspended once — three
    // separate audited actions, enough to prove `limit` actually
    // truncates rather than just happening to return everything.
    for (let i = 0; i < 3; i++) {
      const { restaurantId } = await setUpRestaurantWithPlacedOrder();
      await mutate(ctx, 'post', `/api/v1/admin/restaurants/${restaurantId}/suspend`, admin.cookie)
        .send({ reason: `routine check ${i}` })
        .expect(200);
    }

    const page = await get(ctx, '/api/v1/admin/audit-logs?limit=2', admin.cookie).expect(200);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.meta.pagination).toMatchObject({ limit: 2, hasMore: true });
    const timestamps = page.body.data.map((a: { createdAt: string }) =>
      new Date(a.createdAt).getTime(),
    );
    expect(timestamps[0]).toBeGreaterThanOrEqual(timestamps[1]);
  });

  // ── Payments masking ───────────────────────────────────────────────

  it('GET /admin/payments masks provider references and never exposes the raw provider id', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_FINANCE');
    await setUpRestaurantWithPlacedOrder();
    const payment = ctx.db.payments[0]!;

    const res = await get(ctx, '/api/v1/admin/payments', admin.cookie).expect(200);
    const returned = res.body.data.find((p: { id: string }) => p.id === payment.id);
    expect(returned).toBeDefined();
    expect(returned.providerOrderId).not.toBe(payment.providerOrderId);
    expect(returned.providerOrderId).toMatch(/^\*+.{0,4}$/);
    const bodyText = JSON.stringify(res.body);
    expect(bodyText).not.toContain(payment.providerOrderId);
  });

  it('admin roles are disjoint capability sets, not inherited — ADMIN_OPERATIONS can read payments but not reconcile them', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    await get(ctx, '/api/v1/admin/payments', admin.cookie).expect(200); // payments:read — held by every admin role
    await get(ctx, '/api/v1/admin/reconciliation-issues', admin.cookie).expect(403); // payments:reconcile — FINANCE/SUPER_ADMIN only, docs/05 §9.1
  });

  // ── Phase 19: queue/backlog monitoring ──────────────────────────────

  it('GET /admin/system-health reports outbox/notification backlog depth, oldest-pending age, and open reconciliation issues by severity', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_FINANCE');

    const oldPending = new Date(Date.now() - 3 * 60_000); // 3 min ago — past the 2-min warning threshold
    ctx.db.outboxEvents.push({
      id: randomUUID(),
      eventType: 'ORDER_PLACED',
      payload: {},
      status: 'PENDING',
      attempts: 0,
      lastError: null,
      restaurantId: null,
      createdAt: oldPending,
      processedAt: null,
    });
    ctx.db.notifications.push({
      id: randomUUID(),
      outboxEventId: randomUUID(),
      type: 'ORDER_PLACED',
      category: 'ORDER',
      recipientType: 'CUSTOMER',
      recipientId: randomUUID(),
      channel: 'SMS',
      title: 'x',
      body: 'y',
      contactAddress: null,
      status: 'DEAD_LETTERED',
      readAt: null,
      attempts: 5,
      nextAttemptAt: null,
      lastError: 'provider rejected',
      providerMessageId: null,
      sentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    ctx.db.reconciliationIssues.push({
      id: randomUUID(),
      entityType: 'Order',
      entityId: randomUUID(),
      issueType: 'ORDER_TOTAL_IDENTITY_VIOLATION',
      expected: '100',
      actual: '200',
      severity: 'CRITICAL',
      status: 'OPEN',
      resolutionNote: null,
      resolvedBy: null,
      detectedAt: new Date(),
    });

    const res = await get(ctx, '/api/v1/admin/system-health', admin.cookie).expect(200);
    expect(res.body.data.outbox.pending).toBe(1);
    expect(res.body.data.outbox.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(179);
    expect(res.body.data.outbox.status).toBe('warning');
    expect(res.body.data.notifications.deadLettered).toBe(1);
    expect(res.body.data.notifications.status).not.toBe('ok');
    expect(res.body.data.reconciliationIssues.open).toBe(1);
    expect(res.body.data.reconciliationIssues.bySeverity.CRITICAL).toBe(1);
    expect(res.body.data.overall).not.toBe('ok');
  });

  it('GET /admin/system-health is gated on payments:reconcile — ADMIN_OPERATIONS is forbidden, same as reconciliation-issues', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    await get(ctx, '/api/v1/admin/system-health', admin.cookie).expect(403);
  });

  // ── Notifications, deliveries (cross-tenant, paginated) ─────────────

  it('admin can list and manually retry a dead-lettered notification', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    ctx.db.notifications.push({
      id: randomUUID(),
      outboxEventId: 'evt-1',
      type: 'ORDER_PLACED_CUSTOMER',
      category: 'TRANSACTIONAL',
      recipientType: 'CUSTOMER',
      recipientId: randomUUID(),
      channel: 'SMS',
      title: 'Order placed',
      body: 'Your order has been placed.',
      contactAddress: '+919876543210',
      status: 'DEAD_LETTERED',
      readAt: null,
      attempts: 5,
      nextAttemptAt: null,
      lastError: 'mock SMS provider 500',
      providerMessageId: null,
      sentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const list = await get(
      ctx,
      '/api/v1/admin/notifications?status=DEAD_LETTERED',
      admin.cookie,
    ).expect(200);
    expect(list.body.data).toHaveLength(1);

    await mutate(
      ctx,
      'post',
      `/api/v1/admin/notifications/${list.body.data[0].id}/retry`,
      admin.cookie,
    )
      .send({})
      .expect(200);
    // console adapter never fails — a retry succeeds and the row is SENT again.
    expect(ctx.db.notifications[0]!.status).toBe('SENT');
  });
});
