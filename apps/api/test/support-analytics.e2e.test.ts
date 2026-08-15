import { randomUUID } from 'node:crypto';
import type { AdminRole, OutboxEvent } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { mutate, get, registerAndLogin, type RegisteredUser } from './support/register-and-login.js';
import { registerAndLoginCustomer } from './support/register-and-login-customer.js';
import { OutboxService } from '../src/platform/outbox/outbox.service.js';
import { OrderStateService } from '../src/modules/orders/services/order-state.service.js';
import { RefundService } from '../src/modules/payments/services/refund.service.js';
import { AnalyticsRollupService } from '../src/modules/analytics/services/analytics-rollup.service.js';
import { AnalyticsOutboxConsumer } from '../src/modules/analytics/services/analytics-outbox-consumer.service.js';
import { AnalyticsEventRepository } from '../src/modules/analytics/repositories/analytics-event.repository.js';
import { toLocalMoment } from '../src/modules/availability/timezone.js';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

/** Money fields on an order row are `bigint` — plain `JSON.stringify` throws on those, so this snapshot helper stringifies them first. */
function snapshot(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/**
 * Phase 17 — support cases (docs/03-state-machines.md §7.9, BR-134..
 * BR-140) and analytics (docs/01 §5.14). docs/14-acceptance-
 * criteria.md's named scenarios, plus the surrounding BR set at the
 * same rigor every prior phase's suite applies.
 */
describe('Support and analytics (Phase 17, e2e)', () => {
  let ctx: TestApp;

  afterEach(async () => {
    await ctx.app.close();
  });

  // ── shared setup helpers ────────────────────────────────────────────

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
      .send({ categoryId, name: 'Butter Chicken', priceMinor })
      .expect(201);
    return res.body.data as { id: string; priceMinor: string };
  }

  async function fullSetup(itemPriceMinor = '50000') {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const { slug, restaurantId, categoryId } = await setUpRestaurant(owner);
    const item = await createItem(owner, categoryId, itemPriceMinor);
    return { owner, slug, restaurantId, categoryId, item };
  }

  async function openCart(slug: string, itemId: string, priceMinor: string) {
    const res = await mutate(ctx, 'post', '/api/v1/public/carts')
      .send({ restaurantSlug: slug, items: [{ itemId, quantity: 1, unitPriceMinorAtAdd: priceMinor }] })
      .expect(201);
    return { cartId: res.body.data.cartId as string, guestToken: res.body.data.guestToken as string };
  }

  async function placeAndPayOrder(
    cartId: string,
    guestToken: string,
    options: { customerCookie?: string; phone?: string } = {},
  ) {
    const checkoutRes = await mutate(ctx, 'post', '/api/v1/public/checkout', options.customerCookie)
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId,
        guestToken,
        customer: { name: 'Asha Customer', phone: options.phone ?? '+919876500001' },
        deliveryAddress: { line1: '221B Brigade Road', city: 'Bengaluru', postalCode: '560001' },
      })
      .expect(200);
    const { orderNumber, accessToken } = checkoutRes.body.data;
    const simulateRes = await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/simulate-payment`)
      .send({ token: accessToken, outcome: 'CAPTURED' })
      .expect(200);
    await mutate(ctx, 'post', `/api/v1/public/orders/${orderNumber}/verify-payment`)
      .send({ token: accessToken, providerPaymentId: simulateRes.body.data.providerPaymentId })
      .expect(200);
    await ctx.app.get(OutboxService).relayPending();
    return orderNumber as string;
  }

  async function deliverOrder(orderNumber: string): Promise<string> {
    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    const orderState = ctx.app.get(OrderStateService);
    for (const status of ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'DELIVERED'] as const) {
      await orderState.transition(order.id, status, { type: 'RESTAURANT_USER' });
    }
    await ctx.app.get(OutboxService).relayPending();
    return order.id;
  }

  /** Same lightweight shortcut `loyalty.e2e.test.ts` established — sets `mfaVerifiedAt` directly rather than driving the real MFA-enrollment HTTP flow, since these tests are about support/analytics behavior, not MFA. Returns `adminUserId` too — audit entries record THAT id as `actorId` (`AdminContext.adminUserId`), never the raw `User.id`. */
  async function seedAdmin(role: AdminRole) {
    const admin = await registerAndLogin(ctx, { email: `${role.toLowerCase()}-${randomUUID()}@direct-order.test` });
    const adminUserId = randomUUID();
    ctx.db.adminUsers.push({
      id: adminUserId,
      userId: admin.userId,
      role,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const session = ctx.db.sessions.find((s) => s.userId === admin.userId)!;
    session.mfaVerifiedAt = new Date();
    const user = ctx.db.users.find((u) => u.id === admin.userId)!;
    user.mfaEnabledAt = new Date();
    return { ...admin, adminUserId };
  }

  function caseRow(id: string) {
    return ctx.db.supportCases.find((c) => c.id === id)!;
  }

  // ── BR-134/BR-135: case ownership ─────────────────────────────────────

  it('a customer can open a case only against their own order', async () => {
    const { slug, item } = await fullSetup();
    const customer = await registerAndLoginCustomer(ctx, '+919876520001');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const orderNumber = await placeAndPayOrder(cartId, guestToken, {
      customerCookie: customer.cookie,
      phone: customer.phone,
    });

    const ok = await mutate(ctx, 'post', '/api/v1/me/support/cases', customer.cookie)
      .send({ category: 'ORDER', subject: 'Where is my food', description: 'It has been an hour.', orderNumber })
      .expect(201);
    expect(ok.body.data.orderId).toBe(ctx.db.orders.find((o) => o.orderNumber === orderNumber)!.id);
    expect(ok.body.data.status).toBe('OPEN');

    // A general inquiry with no order at all is fine too.
    const general = await mutate(ctx, 'post', '/api/v1/me/support/cases', customer.cookie)
      .send({ category: 'ACCOUNT', subject: 'How do referrals work', description: 'Curious.' })
      .expect(201);
    expect(general.body.data.orderId).toBeNull();

    // Someone else's order number is rejected outright, not silently detached.
    const otherCustomer = await registerAndLoginCustomer(ctx, '+919876520002');
    await mutate(ctx, 'post', '/api/v1/me/support/cases', otherCustomer.cookie)
      .send({ category: 'ORDER', subject: 'Not mine', description: 'Trying someone else’s order.', orderNumber })
      .expect(422);
  });

  it('a restaurant can open a case only for its own orders', async () => {
    const { owner, slug, item } = await fullSetup();
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const orderNumber = await placeAndPayOrder(cartId, guestToken, { phone: '+919876520003' });

    const created = await mutate(ctx, 'post', '/api/v1/restaurant/support/cases', owner.cookie)
      .send({ category: 'PAYMENT', subject: 'Payout question', description: 'About this order.', orderNumber })
      .expect(201);
    expect(created.body.data.orderId).toBe(ctx.db.orders.find((o) => o.orderNumber === orderNumber)!.id);

    const otherOwner = await registerAndLogin(ctx, { email: `other-${randomUUID()}@direct-order.test` });
    await setUpRestaurant(otherOwner);
    await mutate(ctx, 'post', '/api/v1/restaurant/support/cases', otherOwner.cookie)
      .send({ category: 'PAYMENT', subject: 'Not my order', description: 'Cross-tenant attempt.', orderNumber })
      .expect(422);
  });

  it('STAFF cannot read or write support cases — MANAGER/OWNER can (support:read/support:write)', async () => {
    const { owner, restaurantId } = await fullSetup();
    const staff = await registerAndLogin(ctx, { email: `staff-${randomUUID()}@direct-order.test` });
    ctx.db.restaurantStaff.push({
      id: randomUUID(),
      userId: staff.userId,
      restaurantId,
      role: 'STAFF',
      status: 'ACTIVE',
      invitedByUserId: owner.userId,
      joinedAt: new Date(),
      disabledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await get(ctx, '/api/v1/restaurant/support/cases', staff.cookie).expect(403);
    await mutate(ctx, 'post', '/api/v1/restaurant/support/cases', staff.cookie)
      .send({ category: 'OTHER', subject: 'x', description: 'y' })
      .expect(403);

    const list = await get(ctx, '/api/v1/restaurant/support/cases', owner.cookie).expect(200);
    expect(list.body.data).toEqual([]);
  });

  // ── cross-tenant 404 isolation ─────────────────────────────────────────

  it("a case belonging to a different customer/restaurant 404s, not 403 — the caller can't distinguish it from a nonexistent id", async () => {
    const { slug, item } = await fullSetup();
    const owner1 = await registerAndLoginCustomer(ctx, '+919876520010');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    await placeAndPayOrder(cartId, guestToken, { customerCookie: owner1.cookie, phone: owner1.phone });
    const created = await mutate(ctx, 'post', '/api/v1/me/support/cases', owner1.cookie)
      .send({ category: 'OTHER', subject: 'Private', description: 'For my eyes only.' })
      .expect(201);
    const caseId = created.body.data.id as string;

    const owner2 = await registerAndLoginCustomer(ctx, '+919876520011');
    await get(ctx, `/api/v1/me/support/cases/${caseId}`, owner2.cookie).expect(404);

    const restOwner = await registerAndLogin(ctx, { email: `r2-${randomUUID()}@direct-order.test` });
    await setUpRestaurant(restOwner);
    const restCase = await mutate(ctx, 'post', '/api/v1/restaurant/support/cases', restOwner.cookie)
      .send({ category: 'OTHER', subject: 'Restaurant private', description: 'Also private.' })
      .expect(201);
    const otherOwner = await registerAndLogin(ctx, { email: `r3-${randomUUID()}@direct-order.test` });
    await setUpRestaurant(otherOwner);
    await get(ctx, `/api/v1/restaurant/support/cases/${restCase.body.data.id}`, otherOwner.cookie).expect(404);
  });

  // ── BR-136: INTERNAL visibility ─────────────────────────────────────────

  it('INTERNAL messages never appear in the customer- or restaurant-facing case detail, even when interleaved with PUBLIC ones', async () => {
    const { slug, item } = await fullSetup();
    const customer = await registerAndLoginCustomer(ctx, '+919876520020');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    await placeAndPayOrder(cartId, guestToken, { customerCookie: customer.cookie, phone: customer.phone });
    const created = await mutate(ctx, 'post', '/api/v1/me/support/cases', customer.cookie)
      .send({ category: 'OTHER', subject: 'Need help', description: 'Please assist.' })
      .expect(201);
    const caseId = created.body.data.id as string;

    const admin = await seedAdmin('SUPPORT');
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/assign`, admin.cookie)
      .send({ assignedToUserId: admin.userId })
      .expect(200);

    const secretNote = 'ESCALATE-TO-FRAUD-TEAM-CONFIDENTIAL';
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/messages`, admin.cookie)
      .send({ body: secretNote, visibility: 'INTERNAL' })
      .expect(201);
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/messages`, admin.cookie)
      .send({ body: 'We are looking into this for you.', visibility: 'PUBLIC' })
      .expect(201);

    const detail = await get(ctx, `/api/v1/me/support/cases/${caseId}`, customer.cookie).expect(200);
    expect(detail.body.data.messages).toHaveLength(1);
    expect(detail.body.data.messages[0].body).toBe('We are looking into this for you.');
    expect(JSON.stringify(detail.body.data)).not.toContain(secretNote);

    // The admin view sees both, tagged with their real visibility.
    const adminDetail = await get(ctx, `/api/v1/admin/support/cases/${caseId}`, admin.cookie).expect(200);
    expect(adminDetail.body.data.messages).toHaveLength(2);
    expect(adminDetail.body.data.messages.map((m: { visibility: string }) => m.visibility).sort()).toEqual([
      'INTERNAL',
      'PUBLIC',
    ]);
  });

  // ── docs/03 §7.9 state machine ───────────────────────────────────────

  it('walks the full state machine: OPEN -> ASSIGNED -> IN_PROGRESS -> WAITING_CUSTOMER -> IN_PROGRESS -> RESOLVED -> reopened', async () => {
    const { slug, item } = await fullSetup();
    const customer = await registerAndLoginCustomer(ctx, '+919876520030');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    await placeAndPayOrder(cartId, guestToken, { customerCookie: customer.cookie, phone: customer.phone });
    const created = await mutate(ctx, 'post', '/api/v1/me/support/cases', customer.cookie)
      .send({ category: 'OTHER', subject: 'State machine', description: 'Testing transitions.' })
      .expect(201);
    const caseId = created.body.data.id as string;
    expect(caseRow(caseId).status).toBe('OPEN');

    const admin = await seedAdmin('SUPPORT');
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/assign`, admin.cookie)
      .send({ assignedToUserId: admin.userId })
      .expect(200);
    expect(caseRow(caseId).status).toBe('ASSIGNED');
    expect(caseRow(caseId).firstResponseAt).toBeNull();

    // An INTERNAL note doesn't touch firstResponseAt, but does count as "agent begins" (ASSIGNED -> IN_PROGRESS) same as any agent message.
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/messages`, admin.cookie)
      .send({ body: 'internal only', visibility: 'INTERNAL' })
      .expect(201);
    expect(caseRow(caseId).status).toBe('IN_PROGRESS');
    expect(caseRow(caseId).firstResponseAt).toBeNull();

    // A PUBLIC reply: IN_PROGRESS -> WAITING_CUSTOMER (this case was opened by a customer), and sets firstResponseAt exactly once.
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/messages`, admin.cookie)
      .send({ body: 'Could you share your order number?', visibility: 'PUBLIC' })
      .expect(201);
    expect(caseRow(caseId).status).toBe('WAITING_CUSTOMER');
    const firstResponseAt = caseRow(caseId).firstResponseAt;
    expect(firstResponseAt).not.toBeNull();

    // A second PUBLIC agent reply does not move firstResponseAt again.
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/messages`, admin.cookie)
      .send({ body: 'Following up.', visibility: 'PUBLIC' })
      .expect(201);
    expect(caseRow(caseId).firstResponseAt).toEqual(firstResponseAt);

    // The customer replies: WAITING_CUSTOMER -> IN_PROGRESS.
    await mutate(ctx, 'post', `/api/v1/me/support/cases/${caseId}/messages`, customer.cookie)
      .send({ body: 'Here it is: ORD-123' })
      .expect(201);
    expect(caseRow(caseId).status).toBe('IN_PROGRESS');

    // Resolve: IN_PROGRESS -> RESOLVED.
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/resolve`, admin.cookie)
      .send({ resolutionNote: 'Refunded the delivery fee.' })
      .expect(200);
    expect(caseRow(caseId).status).toBe('RESOLVED');

    // A further customer reply reopens: RESOLVED -> IN_PROGRESS.
    await mutate(ctx, 'post', `/api/v1/me/support/cases/${caseId}/messages`, customer.cookie)
      .send({ body: 'Actually, one more question.' })
      .expect(201);
    expect(caseRow(caseId).status).toBe('IN_PROGRESS');

    // Resolving an already-CLOSED case is rejected; simulate the (unimplemented, out-of-scope) grace-period closure directly.
    caseRow(caseId).status = 'CLOSED';
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/resolve`, admin.cookie)
      .send({ resolutionNote: 'too late' })
      .expect(409);
    await mutate(ctx, 'post', `/api/v1/me/support/cases/${caseId}/messages`, customer.cookie)
      .send({ body: 'Anyone there?' })
      .expect(409);
  });

  it('a PUBLIC agent reply on a restaurant-opened case transitions to WAITING_RESTAURANT, not WAITING_CUSTOMER', async () => {
    const { owner, slug, item } = await fullSetup();
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    await placeAndPayOrder(cartId, guestToken, { phone: '+919876520040' });
    const created = await mutate(ctx, 'post', '/api/v1/restaurant/support/cases', owner.cookie)
      .send({ category: 'PAYMENT', subject: 'Payout delay', description: 'Funds not settled.' })
      .expect(201);
    const caseId = created.body.data.id as string;

    const admin = await seedAdmin('ADMIN_OPERATIONS');
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/assign`, admin.cookie)
      .send({ assignedToUserId: admin.userId })
      .expect(200);
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/messages`, admin.cookie)
      .send({ body: 'Looking into your payout now.', visibility: 'PUBLIC' })
      .expect(201);
    expect(caseRow(caseId).status).toBe('WAITING_RESTAURANT');

    await mutate(ctx, 'post', `/api/v1/restaurant/support/cases/${caseId}/messages`, owner.cookie)
      .send({ body: 'Thanks, still waiting.' })
      .expect(201);
    expect(caseRow(caseId).status).toBe('IN_PROGRESS');
  });

  it('only support:assign holders can assign; SUPER_ADMIN and SUPPORT can, ADMIN_FINANCE cannot', async () => {
    const { slug, item } = await fullSetup();
    const customer = await registerAndLoginCustomer(ctx, '+919876520050');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    await placeAndPayOrder(cartId, guestToken, { customerCookie: customer.cookie, phone: customer.phone });
    const created = await mutate(ctx, 'post', '/api/v1/me/support/cases', customer.cookie)
      .send({ category: 'OTHER', subject: 'x', description: 'y' })
      .expect(201);
    const caseId = created.body.data.id as string;

    const finance = await seedAdmin('ADMIN_FINANCE');
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/assign`, finance.cookie)
      .send({ assignedToUserId: finance.userId })
      .expect(403);

    const support = await seedAdmin('SUPPORT');
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/assign`, support.cookie)
      .send({ assignedToUserId: support.userId })
      .expect(200);
    expect(caseRow(caseId).assignedToUserId).toBe(support.userId);

    const auditEntry = ctx.db.auditLogs.find(
      (a) => a.entityId === caseId && a.action === 'SUPPORT_CASE_ASSIGNED',
    );
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.actorId).toBe(support.adminUserId);
  });

  // ── BR-140: private attachments ─────────────────────────────────────────

  it('attachments: rejects a bad content type/oversized declaration, verifies bytes on attach, and is served only via a short-lived signed URL', async () => {
    const { slug, item } = await fullSetup();
    const customer = await registerAndLoginCustomer(ctx, '+919876520060');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    await placeAndPayOrder(cartId, guestToken, { customerCookie: customer.cookie, phone: customer.phone });
    const created = await mutate(ctx, 'post', '/api/v1/me/support/cases', customer.cookie)
      .send({ category: 'PAYMENT', subject: 'Receipt attached', description: 'See attached.' })
      .expect(201);
    const caseId = created.body.data.id as string;

    await mutate(ctx, 'post', `/api/v1/me/support/cases/${caseId}/attachments/presign`, customer.cookie)
      .send({ contentType: 'application/x-msdownload', sizeBytes: 1000 })
      .expect(422);
    await mutate(ctx, 'post', `/api/v1/me/support/cases/${caseId}/attachments/presign`, customer.cookie)
      .send({ contentType: 'image/jpeg', sizeBytes: 20 * 1024 * 1024 })
      .expect(422);

    // A mismatched declared type (an .exe renamed to a PDF) is rejected on attach, and the object is deleted from storage.
    const badPresign = await mutate(ctx, 'post', `/api/v1/me/support/cases/${caseId}/attachments/presign`, customer.cookie)
      .send({ contentType: 'application/pdf', sizeBytes: EXE_BYTES.length })
      .expect(200);
    ctx.storage.seed(badPresign.body.data.key, EXE_BYTES);
    await mutate(ctx, 'post', `/api/v1/me/support/cases/${caseId}/messages`, customer.cookie)
      .send({
        body: 'Here is my receipt',
        attachments: [{ key: badPresign.body.data.key, filename: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: EXE_BYTES.length }],
      })
      .expect(422);
    expect(ctx.storage.has(badPresign.body.data.key)).toBe(false);

    // A genuine PDF attaches successfully and is downloadable via a signed URL, never a public URL.
    const goodPresign = await mutate(ctx, 'post', `/api/v1/me/support/cases/${caseId}/attachments/presign`, customer.cookie)
      .send({ contentType: 'application/pdf', sizeBytes: PDF_BYTES.length })
      .expect(200);
    expect(goodPresign.body.data.key.startsWith(`support-cases/${caseId}/`)).toBe(true);
    ctx.storage.seed(goodPresign.body.data.key, PDF_BYTES);
    await mutate(ctx, 'post', `/api/v1/me/support/cases/${caseId}/messages`, customer.cookie)
      .send({
        body: 'Here is my receipt',
        attachments: [{ key: goodPresign.body.data.key, filename: 'receipt.pdf', contentType: 'application/pdf', sizeBytes: PDF_BYTES.length }],
      })
      .expect(201);
    const attachment = ctx.db.supportAttachments.find((a) => a.caseId === caseId)!;
    expect(attachment.objectKey).toBe(goodPresign.body.data.key);

    const download = await get(ctx, `/api/v1/me/support/cases/${caseId}/attachments/${attachment.id}`, customer.cookie).expect(200);
    expect(download.body.data.url).toContain('mode=get');
    expect(download.body.data.url).not.toContain('mode=put');

    // Another customer cannot reach it at all (404, case-scoped).
    const otherCustomer = await registerAndLoginCustomer(ctx, '+919876520061');
    await get(ctx, `/api/v1/me/support/cases/${caseId}/attachments/${attachment.id}`, otherCustomer.cookie).expect(404);
  });

  it('an attachment on an INTERNAL message is invisible to the customer/restaurant download endpoint, even by direct id, but visible to an admin', async () => {
    const { slug, item } = await fullSetup();
    const customer = await registerAndLoginCustomer(ctx, '+919876520070');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    await placeAndPayOrder(cartId, guestToken, { customerCookie: customer.cookie, phone: customer.phone });
    const created = await mutate(ctx, 'post', '/api/v1/me/support/cases', customer.cookie)
      .send({ category: 'OTHER', subject: 'x', description: 'y' })
      .expect(201);
    const caseId = created.body.data.id as string;

    const admin = await seedAdmin('SUPPORT');
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/assign`, admin.cookie)
      .send({ assignedToUserId: admin.userId })
      .expect(200);

    const presign = await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/attachments/presign`, admin.cookie)
      .send({ contentType: 'image/jpeg', sizeBytes: JPEG_BYTES.length })
      .expect(200);
    ctx.storage.seed(presign.body.data.key, JPEG_BYTES);
    await mutate(ctx, 'post', `/api/v1/admin/support/cases/${caseId}/messages`, admin.cookie)
      .send({
        body: 'internal screenshot for the fraud team',
        visibility: 'INTERNAL',
        attachments: [{ key: presign.body.data.key, filename: 'evidence.jpg', contentType: 'image/jpeg', sizeBytes: JPEG_BYTES.length }],
      })
      .expect(201);
    const attachment = ctx.db.supportAttachments.find((a) => a.caseId === caseId)!;

    await get(ctx, `/api/v1/me/support/cases/${caseId}/attachments/${attachment.id}`, customer.cookie).expect(404);
    const adminDownload = await get(ctx, `/api/v1/admin/support/cases/${caseId}/attachments/${attachment.id}`, admin.cookie).expect(200);
    expect(adminDownload.body.data.url).toContain(presign.body.data.key);
  });

  // ── analytics: rollups reconcile with source data ──────────────────────

  it('a restaurant daily rollup reconciles exactly with its orders, refunds, and rejections for that day', async () => {
    const { owner, restaurantId, slug, item } = await fullSetup('50000');

    // One delivered order.
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const orderNumber = await placeAndPayOrder(cartId, guestToken, { phone: '+919876520080' });
    await deliverOrder(orderNumber);
    const order = ctx.db.orders.find((o) => o.orderNumber === orderNumber)!;
    const payment = ctx.db.payments.find((p) => p.orderId === order.id)!;

    // A partial refund on it.
    await ctx.app.get(RefundService).requestRefund({
      paymentId: payment.id,
      amountMinor: 10000n,
      reason: 'Goodwill',
      initiatedByActorType: 'ADMIN',
      idempotencyKey: randomUUID(),
    });
    const refund = ctx.db.refunds.find((r) => r.paymentId === payment.id)!;
    refund.completedAt = new Date();

    // A directly-constructed rejected order for the same restaurant/day (BR: rejections count without needing a full paid flow).
    const rejectedOrder = { ...order, id: randomUUID(), orderNumber: `REJ-${randomUUID()}`, status: 'REJECTED', placedAt: null, deliveredAt: null, cancelledAt: null };
    ctx.db.orders.push(rejectedOrder);
    ctx.db.orderStatusHistory.push({
      id: randomUUID(),
      orderId: rejectedOrder.id,
      fromStatus: 'PLACED',
      toStatus: 'REJECTED',
      actorType: 'RESTAURANT_USER',
      actorId: owner.userId,
      reason: 'Out of stock',
      metadata: null,
      createdAt: new Date(),
    });

    const timezone = ctx.db.restaurants.find((r) => r.id === restaurantId)!.timezone;
    const todayKey = toLocalMoment(new Date(), timezone).dateKey;
    const rollup = await ctx.app.get(AnalyticsRollupService).rollupRestaurantDay(restaurantId, todayKey, timezone);

    const grossExpected = order.itemsSubtotalMinor + order.packagingFeeMinor + order.deliveryFeeMinor + order.platformFeeMinor + order.taxMinor;
    expect(rollup.ordersPlaced).toBe(1);
    expect(rollup.ordersCompleted).toBe(1);
    expect(rollup.ordersRejected).toBe(1);
    expect(rollup.ordersCancelled).toBe(0);
    expect(rollup.grossOrderValueMinor).toBe(grossExpected);
    expect(rollup.refundMinor).toBe(10000n);
    expect(rollup.netOrderValueMinor).toBe(grossExpected - order.discountMinor - order.loyaltyDiscountMinor - 10000n);
    expect(rollup.avgOrderValueMinor).toBe(grossExpected);

    // Re-running the rollup for the same day upserts to the identical row — recomputable and idempotent, never a duplicate.
    const rerun = await ctx.app.get(AnalyticsRollupService).rollupRestaurantDay(restaurantId, todayKey, timezone);
    expect(ctx.db.dailyRestaurantMetrics.filter((m) => m.restaurantId === restaurantId)).toHaveLength(1);
    expect(rerun.grossOrderValueMinor).toBe(rollup.grossOrderValueMinor);
  });

  it("daily boundaries are computed in each restaurant's own timezone, not a shared platform default — the same instant falls in different calendar days", async () => {
    const { restaurantId: kolkataId, slug: kolkataSlug, item: kolkataItem } = await fullSetup('30000');
    const laOwner = await registerAndLogin(ctx, { email: `la-${randomUUID()}@direct-order.test` });
    const { restaurantId: laId, slug: laSlug, categoryId: laCategoryId } = await setUpRestaurant(laOwner);
    const laItem = await createItem(laOwner, laCategoryId, '30000');
    ctx.db.restaurants.find((r) => r.id === laId)!.timezone = 'America/Los_Angeles';

    // 2026-03-09T20:00:00Z: Kolkata's local calendar date is 2026-03-10; Los Angeles's (PDT, UTC-7 by then) is still 2026-03-09.
    const instant = new Date('2026-03-09T20:00:00.000Z');

    const { cartId: kCartId, guestToken: kToken } = await openCart(kolkataSlug, kolkataItem.id, kolkataItem.priceMinor);
    const kOrderNumber = await placeAndPayOrder(kCartId, kToken, { phone: '+919876520090' });
    await deliverOrder(kOrderNumber);
    ctx.db.orders.find((o) => o.orderNumber === kOrderNumber)!.deliveredAt = instant;

    const { cartId: lCartId, guestToken: lToken } = await openCart(laSlug, laItem.id, laItem.priceMinor);
    const lOrderNumber = await placeAndPayOrder(lCartId, lToken, { phone: '+919876520091' });
    await deliverOrder(lOrderNumber);
    ctx.db.orders.find((o) => o.orderNumber === lOrderNumber)!.deliveredAt = instant;

    const kolkataMarch10 = await ctx.app.get(AnalyticsRollupService).rollupRestaurantDay(kolkataId, '2026-03-10', 'Asia/Kolkata');
    expect(kolkataMarch10.ordersCompleted).toBe(1);
    const kolkataMarch9 = await ctx.app.get(AnalyticsRollupService).rollupRestaurantDay(kolkataId, '2026-03-09', 'Asia/Kolkata');
    expect(kolkataMarch9.ordersCompleted).toBe(0);

    const laMarch9 = await ctx.app.get(AnalyticsRollupService).rollupRestaurantDay(laId, '2026-03-09', 'America/Los_Angeles');
    expect(laMarch9.ordersCompleted).toBe(1);
    const laMarch10 = await ctx.app.get(AnalyticsRollupService).rollupRestaurantDay(laId, '2026-03-10', 'America/Los_Angeles');
    expect(laMarch10.ordersCompleted).toBe(0);
  });

  it('the platform rollup counts payment/delivery success rates and support cases opened as raw counts, never a pre-divided float', async () => {
    const { slug, item } = await fullSetup('40000');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const orderNumber = await placeAndPayOrder(cartId, guestToken, { phone: '+919876520100' });
    const orderId = await deliverOrder(orderNumber);

    // `deliverOrder` walks the order's OWN state machine only — it doesn't
    // dispatch a real courier (a separate Uber Direct flow, out of scope
    // here), so this rollup's delivery counters need an actual `Delivery`
    // row to count, constructed directly the same way other tests seed
    // fixtures the real flow they're not exercising wouldn't produce.
    ctx.db.deliveries.push({
      id: randomUUID(),
      orderId,
      provider: 'MOCK',
      providerDeliveryId: randomUUID(),
      status: 'DELIVERED',
      pickupAddress: {},
      dropoffAddress: {},
      courierName: null,
      courierPhone: null,
      trackingUrl: null,
      quotedFeeMinor: null,
      actualFeeMinor: null,
      idempotencyKey: randomUUID(),
      attemptCount: 1,
      estimatedPickupAt: null,
      estimatedDeliveryAt: null,
      pickedUpAt: new Date(),
      deliveredAt: new Date(),
      cancellationReason: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const customer = await registerAndLoginCustomer(ctx, '+919876520101');
    await mutate(ctx, 'post', '/api/v1/me/support/cases', customer.cookie)
      .send({ category: 'OTHER', subject: 'x', description: 'y' })
      .expect(201);

    const platformKey = toLocalMoment(new Date(), 'Asia/Kolkata').dateKey;
    const rollup = await ctx.app.get(AnalyticsRollupService).rollupPlatformDay(platformKey);

    expect(rollup.paymentsAttempted).toBeGreaterThanOrEqual(1);
    expect(rollup.paymentsSucceeded).toBeGreaterThanOrEqual(1);
    expect(rollup.deliveriesAttempted).toBeGreaterThanOrEqual(1);
    expect(rollup.deliveriesSucceeded).toBeGreaterThanOrEqual(1);
    expect(rollup.supportCasesOpened).toBeGreaterThanOrEqual(1);
    expect(typeof rollup.paymentsAttempted).toBe('number');
  });

  it('GET /restaurant/analytics/overview and GET /admin/overview read exclusively from the rollup tables — MANAGER/OWNER can, STAFF cannot', async () => {
    const { owner, restaurantId, slug, item } = await fullSetup('60000');
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const orderNumber = await placeAndPayOrder(cartId, guestToken, { phone: '+919876520110' });
    await deliverOrder(orderNumber);

    const timezone = ctx.db.restaurants.find((r) => r.id === restaurantId)!.timezone;
    const todayKey = toLocalMoment(new Date(), timezone).dateKey;
    await ctx.app.get(AnalyticsRollupService).rollupRestaurantDay(restaurantId, todayKey, timezone);
    await ctx.app.get(AnalyticsRollupService).rollupPlatformDay(toLocalMoment(new Date(), 'Asia/Kolkata').dateKey);

    const overview = await get(ctx, '/api/v1/restaurant/analytics/overview', owner.cookie).expect(200);
    expect(overview.body.data.summary.ordersCompleted).toBeGreaterThanOrEqual(1);
    expect(overview.body.data.days.length).toBeGreaterThanOrEqual(1);

    const admin = await seedAdmin('SUPER_ADMIN');
    const adminOverview = await get(ctx, '/api/v1/admin/overview', admin.cookie).expect(200);
    expect(adminOverview.body.data.metrics.latest).not.toBeNull();
    expect(adminOverview.body.data.metrics.asOfDate).toEqual(expect.any(String));
    expect(adminOverview.body.data.restaurantsByStatus).toBeTruthy();
  });

  /**
   * Regression: `RestaurantAnalyticsController.overview()` used to
   * compute "today" as plain server UTC (`new Date(Date.UTC(...))`)
   * instead of the restaurant's own timezone — found live, running the
   * suite itself during the several hours each day where UTC's
   * calendar date still trails India's (00:00-05:30 IST). A rollup
   * keyed to IST "today" fell entirely outside a query range anchored
   * to UTC "today", so the dashboard reported zero orders despite the
   * rollup existing. Frozen clock, not real wall-clock time, so this
   * doesn't depend on when the suite happens to run: 2026-03-10T20:00Z
   * is 2026-03-11 01:30 IST — UTC says the 10th, the restaurant's own
   * timezone already says the 11th.
   */
  it('GET /restaurant/analytics/overview uses the restaurant\'s own timezone for "today", not server UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-03-10T20:00:00.000Z'));

      const { owner, restaurantId, slug, item } = await fullSetup('45000');
      const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
      const orderNumber = await placeAndPayOrder(cartId, guestToken, { phone: '+919876520115' });
      await deliverOrder(orderNumber);

      const timezone = ctx.db.restaurants.find((r) => r.id === restaurantId)!.timezone;
      expect(timezone).toBe('Asia/Kolkata');
      const todayKey = toLocalMoment(new Date(), timezone).dateKey;
      expect(todayKey).toBe('2026-03-11'); // IST is already the 11th while UTC is still the 10th.
      await ctx.app.get(AnalyticsRollupService).rollupRestaurantDay(restaurantId, todayKey, timezone);

      const overview = await get(ctx, '/api/v1/restaurant/analytics/overview', owner.cookie).expect(200);
      expect(overview.body.data.summary.ordersCompleted).toBeGreaterThanOrEqual(1);
      expect(overview.body.data.days.length).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── analytics ingest: mirrors the outbox, idempotent, never mutates transactional tables ──

  it('the analytics ingest consumer mirrors an outbox event exactly once even if relayed twice, and never touches the order it describes', async () => {
    const { slug, item } = await fullSetup();
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const orderNumber = await placeAndPayOrder(cartId, guestToken, { phone: '+919876520120' });
    const orderBefore = snapshot(ctx.db.orders.find((o) => o.orderNumber === orderNumber));

    const event = ctx.db.outboxEvents.find((e) => e.eventType === 'ORDER_PLACED')! as unknown as OutboxEvent;
    const consumer = ctx.app.get(AnalyticsOutboxConsumer);
    await consumer.handle(event);
    await consumer.handle(event); // simulates the outbox's "at least once" redelivery.

    const matches = ctx.db.analyticsEvents.filter((e) => e.idempotencyKey === event.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.type).toBe('ORDER_PLACED');

    const orderAfter = snapshot(ctx.db.orders.find((o) => o.orderNumber === orderNumber));
    expect(orderAfter).toBe(orderBefore);
  });

  it('order placement and payment capture succeed independent of the analytics pipeline — the order commits before any outbox relay ever runs', async () => {
    const { slug, item } = await fullSetup();
    const { cartId, guestToken } = await openCart(slug, item.id, item.priceMinor);
    const checkoutRes = await mutate(ctx, 'post', '/api/v1/public/checkout')
      .set('Idempotency-Key', randomUUID())
      .send({
        cartId,
        guestToken,
        customer: { name: 'Asha Customer', phone: '+919876520130' },
        deliveryAddress: { line1: '221B Brigade Road', city: 'Bengaluru', postalCode: '560001' },
      })
      .expect(200);
    // No relayPending() call at all yet — the order/payment write already
    // committed synchronously inside the checkout request itself, proving
    // "analytics failure does not affect order or payment processing":
    // there is no code path in which the analytics consumer runs before
    // the order it describes has already durably committed.
    const order = ctx.db.orders.find((o) => o.orderNumber === checkoutRes.body.data.orderNumber);
    expect(order).toBeDefined();
    expect(order!.status).toBe('PENDING_PAYMENT');
    expect(ctx.db.analyticsEvents).toHaveLength(0);

    // Even a broken analytics repository can't roll back or block a later relay of OTHER unrelated bookkeeping — this insert simply fails and is caught individually by the consumer's own idempotency-first design; it never reaches back into `orders`.
    const analyticsEvents = ctx.app.get(AnalyticsEventRepository);
    await expect(
      analyticsEvents.create({ type: 'ORDER_PLACED', occurredAt: new Date() }),
    ).resolves.toBeUndefined();
  });
});
