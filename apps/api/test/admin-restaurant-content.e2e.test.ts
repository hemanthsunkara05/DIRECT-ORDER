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

/**
 * Phase 22 — admin-assisted restaurant management (concierge onboarding).
 * Covers: admin-created restaurants (both owner-resolution branches),
 * the reconciliation round-trip with the EXISTING, unmodified claim flow,
 * admin content edits (profile/branding/hours) and their audit
 * attribution, the owner-facing "an admin changed something" surface,
 * and every new endpoint's authorization negative cases.
 */
describe('Admin-assisted restaurant management (Phase 22, e2e)', () => {
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

  // ── Creation: owner resolution ──────────────────────────────────────

  it('creating with no owner info produces a placeholder-owned restaurant that appears in the unclaimed worklist', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');

    const res = await mutate(ctx, 'post', '/api/v1/admin/restaurants', admin.cookie)
      .send({ name: "Sandhya's Kitchen" })
      .expect(201);
    expect(res.body.data.status).toBe('DRAFT');

    const unclaimed = await get(ctx, '/api/v1/admin/restaurants/unclaimed', admin.cookie).expect(
      200,
    );
    expect(unclaimed.body.data.map((r: { name: string }) => r.name)).toContain("Sandhya's Kitchen");

    const auditRow = ctx.db.auditLogs.find(
      (a) => a.action === 'RESTAURANT_CREATED' && a.entityId === res.body.data.id,
    );
    expect(auditRow).toBeDefined();
    expect(auditRow!.actorType).toBe('ADMIN');
    expect(auditRow!.actorId).toBe(admin.adminUserId);
  });

  it('a second placeholder-owned listing succeeds after the first exists (Gap 1 regression — the one-owner-one-restaurant guard must exempt the placeholder)', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');

    await mutate(ctx, 'post', '/api/v1/admin/restaurants', admin.cookie)
      .send({ name: 'First Prospect' })
      .expect(201);
    await mutate(ctx, 'post', '/api/v1/admin/restaurants', admin.cookie)
      .send({ name: 'Second Prospect' })
      .expect(201);

    const unclaimed = await get(ctx, '/api/v1/admin/restaurants/unclaimed', admin.cookie).expect(
      200,
    );
    expect(unclaimed.body.data.map((r: { name: string }) => r.name).sort()).toEqual([
      'First Prospect',
      'Second Prospect',
    ]);
  });

  it('creating with an ownerEmail matching an existing account assigns that account as OWNER immediately — the restaurant never appears as unclaimed', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });

    const res = await mutate(ctx, 'post', '/api/v1/admin/restaurants', admin.cookie)
      .send({ name: 'Fresh Kitchen', ownerEmail: owner.email })
      .expect(201);

    const unclaimed = await get(ctx, '/api/v1/admin/restaurants/unclaimed', admin.cookie).expect(
      200,
    );
    expect(unclaimed.body.data.map((r: { name: string }) => r.name)).not.toContain('Fresh Kitchen');

    // The claimed owner can now manage it directly, exactly like a self-serve restaurant.
    const profile = await get(ctx, '/api/v1/restaurant/profile', owner.cookie).expect(200);
    expect(profile.body.data.id).toBe(res.body.data.id);
  });

  it('creating with an ownerPhone matching an existing account resolves the same way as ownerEmail', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const ownerRow = ctx.db.users.find((u) => u.id === owner.userId)!;
    ownerRow.phone = '9876500000';

    await mutate(ctx, 'post', '/api/v1/admin/restaurants', admin.cookie)
      .send({ name: 'Copper Kettle', ownerPhone: '9876500000' })
      .expect(201);

    const profile = await get(ctx, '/api/v1/restaurant/profile', owner.cookie).expect(200);
    expect(profile.body.data.name).toBe('Copper Kettle');
  });

  it('an ownerEmail that resolves to a user who already owns a restaurant is rejected (409) — the one-owner-one-restaurant guard still applies to a REAL owner', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Already Has One' })
      .expect(201);

    await mutate(ctx, 'post', '/api/v1/admin/restaurants', admin.cookie)
      .send({ name: 'Second Attempt', ownerEmail: owner.email })
      .expect(409);
  });

  it('an ownerEmail that matches no account falls back to the placeholder rather than erroring', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');

    await mutate(ctx, 'post', '/api/v1/admin/restaurants', admin.cookie)
      .send({ name: 'Guessed Wrong', ownerEmail: 'nobody-registered@example.com' })
      .expect(201);

    const unclaimed = await get(ctx, '/api/v1/admin/restaurants/unclaimed', admin.cookie).expect(
      200,
    );
    expect(unclaimed.body.data.map((r: { name: string }) => r.name)).toContain('Guessed Wrong');
  });

  // ── Reconciliation round-trip ────────────────────────────────────────

  it('a restaurant an admin created unclaimed can later be claimed through the EXISTING, unmodified claim flow', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const created = await mutate(ctx, 'post', '/api/v1/admin/restaurants', admin.cookie)
      .send({ name: 'Rajahmundry Diner', slug: 'rajahmundry-diner' })
      .expect(201);

    const claimer = await registerAndLogin(ctx, {
      email: `claimer-${randomUUID()}@spiceroute.test`,
    });
    const claimRes = await mutate(ctx, 'post', '/api/v1/restaurants/claim', claimer.cookie)
      .send({ slug: 'rajahmundry-diner' })
      .expect(200);
    expect(claimRes.body.data.id).toBe(created.body.data.id);
    expect(claimRes.body.data.status).toBe('DRAFT');
    expect(claimRes.body.data.onboardingStatus).toBe('NOT_STARTED');

    const unclaimed = await get(ctx, '/api/v1/admin/restaurants/unclaimed', admin.cookie).expect(
      200,
    );
    expect(unclaimed.body.data.map((r: { slug: string }) => r.slug)).not.toContain(
      'rajahmundry-diner',
    );

    // The claiming owner can now manage it directly.
    await get(ctx, '/api/v1/restaurant/profile', claimer.cookie).expect(200);
  });

  // ── Creation authorization negatives ─────────────────────────────────

  it('POST /admin/restaurants: unauthenticated -> 401, restaurant owner (no AdminUser row) -> 403, admin without restaurant:create (SUPPORT) -> 403', async () => {
    ctx = await createTestApp();
    const owner = await registerAndLogin(ctx);
    const support = await registerAdmin('SUPPORT');

    await mutate(ctx, 'post', '/api/v1/admin/restaurants').send({ name: 'x' }).expect(401);
    await mutate(ctx, 'post', '/api/v1/admin/restaurants', owner.cookie)
      .send({ name: 'x' })
      .expect(403);
    await mutate(ctx, 'post', '/api/v1/admin/restaurants', support.cookie)
      .send({ name: 'x' })
      .expect(403);
  });

  // ── Profile / branding / hours edits ─────────────────────────────────

  async function createAdminRestaurant(admin: AdminPrincipal, name = 'Fresh Kitchen') {
    const res = await mutate(ctx, 'post', '/api/v1/admin/restaurants', admin.cookie)
      .send({ name })
      .expect(201);
    return res.body.data.id as string;
  }

  it('admin can view and edit profile/address; persists and is audited as ADMIN', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const restaurantId = await createAdminRestaurant(admin);

    const updateRes = await mutate(
      ctx,
      'patch',
      `/api/v1/admin/restaurants/${restaurantId}/profile`,
      admin.cookie,
    )
      .send({
        description: 'Concierge-onboarded listing',
        address: {
          line1: '1 MG Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        },
      })
      .expect(200);
    expect(updateRes.body.data.description).toBe('Concierge-onboarded listing');
    expect(updateRes.body.data.address).toMatchObject({ city: 'Bengaluru' });

    const getRes = await get(
      ctx,
      `/api/v1/admin/restaurants/${restaurantId}/profile`,
      admin.cookie,
    ).expect(200);
    expect(getRes.body.data.description).toBe('Concierge-onboarded listing');

    const auditRow = ctx.db.auditLogs.find(
      (a) => a.action === 'RESTAURANT_PROFILE_UPDATED' && a.entityId === restaurantId,
    );
    expect(auditRow!.actorType).toBe('ADMIN');
    expect(auditRow!.actorId).toBe(admin.adminUserId);
  });

  it('admin can view and edit branding; persists and is audited as ADMIN', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const restaurantId = await createAdminRestaurant(admin);

    await mutate(ctx, 'patch', `/api/v1/admin/restaurants/${restaurantId}/branding`, admin.cookie)
      .send({ tagline: 'Home-style Andhra food' })
      .expect(200);

    const getRes = await get(
      ctx,
      `/api/v1/admin/restaurants/${restaurantId}/branding`,
      admin.cookie,
    ).expect(200);
    expect(getRes.body.data.tagline).toBe('Home-style Andhra food');

    const auditRow = ctx.db.auditLogs.find(
      (a) => a.action === 'RESTAURANT_BRANDING_UPDATED' && a.restaurantId === restaurantId,
    );
    expect(auditRow!.actorType).toBe('ADMIN');
  });

  it('admin can view and edit hours; persists and is audited as ADMIN', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const restaurantId = await createAdminRestaurant(admin);

    await mutate(ctx, 'put', `/api/v1/admin/restaurants/${restaurantId}/hours`, admin.cookie)
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAt: '09:00',
          closesAt: '22:00',
        })),
      })
      .expect(200);

    const getRes = await get(
      ctx,
      `/api/v1/admin/restaurants/${restaurantId}/hours`,
      admin.cookie,
    ).expect(200);
    expect(getRes.body.data).toHaveLength(7);

    const auditRow = ctx.db.auditLogs.find(
      (a) => a.action === 'RESTAURANT_HOURS_SET' && a.restaurantId === restaurantId,
    );
    expect(auditRow!.actorType).toBe('ADMIN');
  });

  it('GET on a nonexistent restaurant id 404s', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');

    await get(ctx, `/api/v1/admin/restaurants/${randomUUID()}/profile`, admin.cookie).expect(404);
  });

  // ── Content-edit authorization negatives ─────────────────────────────

  it('restaurant staff (real membership, no AdminUser row) get 403 on the admin content routes, even for their OWN restaurant', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Owner Kitchen' })
      .expect(201);
    const restaurantId = created.body.data.id as string;
    void admin;

    await mutate(ctx, 'patch', `/api/v1/admin/restaurants/${restaurantId}/profile`, owner.cookie)
      .send({ description: 'should not work' })
      .expect(403);
    await get(ctx, `/api/v1/admin/restaurants/${restaurantId}/profile`, owner.cookie).expect(403);
  });

  it('an admin with restaurant:read but not restaurant:admin_edit (SUPPORT) can GET but not PATCH/PUT', async () => {
    ctx = await createTestApp();
    const support = await registerAdmin('SUPPORT');
    const opsAdmin = await registerAdmin(
      'ADMIN_OPERATIONS',
      `ops-${randomUUID()}@direct-order.test`,
    );
    const restaurantId = await createAdminRestaurant(opsAdmin);

    await get(ctx, `/api/v1/admin/restaurants/${restaurantId}/profile`, support.cookie).expect(200);
    await mutate(ctx, 'patch', `/api/v1/admin/restaurants/${restaurantId}/profile`, support.cookie)
      .send({ description: 'nope' })
      .expect(403);
    await mutate(ctx, 'put', `/api/v1/admin/restaurants/${restaurantId}/hours`, support.cookie)
      .send({ days: [] })
      .expect(403);
  });

  // ── Submit for approval — Phase 21's gate is not bypassed ────────────

  it('admin can submit a fully-set-up restaurant for approval, and it still requires a SEPARATE approve action before going ACTIVE', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const restaurantId = await createAdminRestaurant(admin);
    await mutate(ctx, 'patch', `/api/v1/admin/restaurants/${restaurantId}/profile`, admin.cookie)
      .send({
        address: {
          line1: '1 MG Road',
          city: 'Bengaluru',
          state: 'Karnataka',
          postalCode: '560001',
        },
      })
      .expect(200);

    const submitRes = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/submit-for-approval`,
      admin.cookie,
    )
      .send({})
      .expect(200);
    expect(submitRes.body.data.status).toBe('PENDING_APPROVAL');

    const submitAudit = ctx.db.auditLogs.find(
      (a) => a.action === 'RESTAURANT_ONBOARDING_SUBMITTED' && a.entityId === restaurantId,
    );
    expect(submitAudit!.actorType).toBe('ADMIN');

    // Still not ACTIVE — the same admin must take a separate, explicit approve action.
    const midway = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
    expect(midway.status).toBe('PENDING_APPROVAL');

    const approveRes = await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/approve`,
      admin.cookie,
    )
      .send({})
      .expect(200);
    expect(approveRes.body.data.status).toBe('ACTIVE');
  });

  it('submitting for approval without an address fails (409) — same gate the owner-side path enforces', async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const restaurantId = await createAdminRestaurant(admin);

    await mutate(
      ctx,
      'post',
      `/api/v1/admin/restaurants/${restaurantId}/submit-for-approval`,
      admin.cookie,
    )
      .send({})
      .expect(409);
  });

  // ── Owner-facing activity surface ─────────────────────────────────────

  it("GET /restaurant/activity is empty until an admin touches the restaurant, then lists admin-attributed entries — never the owner's own edits", async () => {
    ctx = await createTestApp();
    const admin = await registerAdmin('ADMIN_OPERATIONS');
    const owner = await registerAndLogin(ctx, { email: `owner-${randomUUID()}@spiceroute.test` });
    const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Owner Kitchen' })
      .expect(201);
    const restaurantId = created.body.data.id as string;

    const before = await get(ctx, '/api/v1/restaurant/activity', owner.cookie).expect(200);
    expect(before.body.data).toEqual([]);

    // The owner's OWN edit must never show up as "admin activity".
    await mutate(ctx, 'patch', '/api/v1/restaurant/profile', owner.cookie)
      .send({ description: 'owner edit' })
      .expect(200);
    const stillEmpty = await get(ctx, '/api/v1/restaurant/activity', owner.cookie).expect(200);
    expect(stillEmpty.body.data).toEqual([]);

    await mutate(ctx, 'patch', `/api/v1/admin/restaurants/${restaurantId}/branding`, admin.cookie)
      .send({ tagline: 'Set up by Direct-Order support' })
      .expect(200);

    const after = await get(ctx, '/api/v1/restaurant/activity', owner.cookie).expect(200);
    expect(after.body.data).toHaveLength(1);
    expect(after.body.data[0]).toMatchObject({ action: 'RESTAURANT_BRANDING_UPDATED' });
    expect(after.body.data[0]).not.toHaveProperty('actorId');
  });
});
