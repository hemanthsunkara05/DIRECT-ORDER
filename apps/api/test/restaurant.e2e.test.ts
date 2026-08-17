import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { get, mutate, registerAndLogin } from './support/register-and-login.js';

const UNCLAIMED_PLACEHOLDER_EMAIL = 'unclaimed-listings@direct-order.local';

/** Mirrors what the Rajahmundry outreach script does — a Restaurant owned only by the unclaimed-listing placeholder. */
async function seedUnclaimedListing(ctx: TestApp, slug: string, name = 'Sandhya\'s Kitchen') {
  const placeholder = await ctx.db.prisma.user.create({
    data: { email: UNCLAIMED_PLACEHOLDER_EMAIL, fullName: 'Unclaimed Listing', status: 'ACTIVE' },
  });
  const restaurant = await ctx.db.prisma.restaurant.create({
    data: { slug, name, status: 'ACTIVE', onboardingStatus: 'NOT_STARTED', orderingEnabled: false },
  });
  await ctx.db.prisma.restaurantStaff.create({
    data: { restaurantId: restaurant.id, userId: placeholder.id, role: 'OWNER' },
  });
  return restaurant;
}

describe('Restaurants (Phase 5, e2e)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  describe('POST /restaurants', () => {
    it('creates a restaurant owned by the authenticated user, ignoring any ownerId in the body (docs/14-acceptance-criteria.md, Phase 5)', async () => {
      const owner = await registerAndLogin(ctx);

      const res = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route', ownerId: 'someone-elses-user-id' })
        .expect(201);

      expect(res.body.data.name).toBe('Spice Route');
      expect(res.body.data.slug).toBe('spice-route');
      expect(res.body.data.status).toBe('DRAFT');
      expect(res.body.data.onboardingStatus).toBe('IN_PROGRESS');

      const membership = ctx.db.restaurantStaff.find((s) => s.restaurantId === res.body.data.id);
      expect(membership?.userId).toBe(owner.userId);
      expect(membership?.role).toBe('OWNER');
    });

    it('auto-generates and disambiguates a slug when none is supplied', async () => {
      const ownerA = await registerAndLogin(ctx);
      const ownerB = await registerAndLogin(ctx);

      const first = await mutate(ctx, 'post', '/api/v1/restaurants', ownerA.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);
      const second = await mutate(ctx, 'post', '/api/v1/restaurants', ownerB.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);

      expect(first.body.data.slug).toBe('spice-route');
      expect(second.body.data.slug).toBe('spice-route-2');
    });

    it('rejects a reserved slug with a clear message (docs/14-acceptance-criteria.md, Phase 5)', async () => {
      const owner = await registerAndLogin(ctx);

      const res = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Admin Panel', slug: 'admin' })
        .expect(422);

      expect(res.body.error.message).toMatch(/reserved/i);
    });

    it('rejects an explicit slug that is already taken', async () => {
      const ownerA = await registerAndLogin(ctx);
      const ownerB = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', ownerA.cookie)
        .send({ name: 'Spice Route', slug: 'spice-route' })
        .expect(201);

      const res = await mutate(ctx, 'post', '/api/v1/restaurants', ownerB.cookie)
        .send({ name: 'Something Else', slug: 'spice-route' })
        .expect(409);
      expect(res.body.error.message).toMatch(/already taken/i);
    });

    it('rejects a malformed explicit slug (uppercase, too short) with 422', async () => {
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route', slug: 'AB' })
        .expect(422);
    });

    it('requires authentication', async () => {
      await mutate(ctx, 'post', '/api/v1/restaurants').send({ name: 'Spice Route' }).expect(401);
    });

    // Regression: /qa found the frontend onboarding wizard resumes from
    // user.restaurantMemberships[0], and a stale client-side session
    // right after a claim (fixed separately in login/page.tsx) could
    // land a caller here despite already owning one — this is the
    // backend half of that same one-owner-one-restaurant invariant,
    // previously enforced only by claimRestaurant(), not this endpoint.
    // Found by /qa on 2026-08-16.
    it('cannot create a second restaurant while already owning one', async () => {
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'First Place' })
        .expect(201);

      const res = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Second Place' })
        .expect(409);
      expect(res.body.error.message).toMatch(/already manages a restaurant/i);
    });
  });

  describe('POST /restaurants/claim', () => {
    it('claims an unclaimed listing: caller becomes OWNER, status resets to DRAFT for real onboarding', async () => {
      const listing = await seedUnclaimedListing(ctx, 'sandhya-s-kitchen');
      const owner = await registerAndLogin(ctx);

      const res = await mutate(ctx, 'post', '/api/v1/restaurants/claim', owner.cookie)
        .send({ slug: 'sandhya-s-kitchen' })
        .expect(200);

      expect(res.body.data.id).toBe(listing.id);
      expect(res.body.data.status).toBe('DRAFT');
      expect(res.body.data.onboardingStatus).toBe('NOT_STARTED');

      const staff = ctx.db.restaurantStaff.filter((s) => s.restaurantId === listing.id);
      expect(staff).toHaveLength(1);
      expect(staff[0]?.userId).toBe(owner.userId);
      expect(staff[0]?.role).toBe('OWNER');

      // The placeholder's ownership is fully gone, not just superseded.
      const placeholder = ctx.db.users.find((u) => u.email === UNCLAIMED_PLACEHOLDER_EMAIL)!;
      expect(staff.some((s) => s.userId === placeholder.id)).toBe(false);

      // Matches createRestaurant()'s own eager-settings invariant.
      expect(ctx.db.restaurantSettings.some((s) => s.restaurantId === listing.id)).toBe(true);
    });

    it('cannot claim the same listing twice', async () => {
      await seedUnclaimedListing(ctx, 'sandhya-s-kitchen');
      const first = await registerAndLogin(ctx, { email: 'first@spiceroute.test' });
      await mutate(ctx, 'post', '/api/v1/restaurants/claim', first.cookie)
        .send({ slug: 'sandhya-s-kitchen' })
        .expect(200);

      const second = await registerAndLogin(ctx, { email: 'second@spiceroute.test' });
      const res = await mutate(ctx, 'post', '/api/v1/restaurants/claim', second.cookie)
        .send({ slug: 'sandhya-s-kitchen' })
        .expect(409);
      expect(res.body.error.message).toMatch(/already been claimed/i);
    });

    it('cannot claim a listing while already owning a restaurant — one owner, one restaurant', async () => {
      await seedUnclaimedListing(ctx, 'sandhya-s-kitchen');
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'My Existing Place' })
        .expect(201);

      const res = await mutate(ctx, 'post', '/api/v1/restaurants/claim', owner.cookie)
        .send({ slug: 'sandhya-s-kitchen' })
        .expect(409);
      expect(res.body.error.message).toMatch(/already manages a restaurant/i);
    });

    it('claiming a restaurant that was never a preview listing (real owner already) is rejected the same way', async () => {
      const realOwner = await registerAndLogin(ctx, { email: 'real@spiceroute.test' });
      await mutate(ctx, 'post', '/api/v1/restaurants', realOwner.cookie)
        .send({ name: 'Already Real', slug: 'already-real' })
        .expect(201);

      const claimer = await registerAndLogin(ctx, { email: 'claimer@spiceroute.test' });
      await mutate(ctx, 'post', '/api/v1/restaurants/claim', claimer.cookie)
        .send({ slug: 'already-real' })
        .expect(409);
    });

    it('404s for a slug that does not exist', async () => {
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants/claim', owner.cookie)
        .send({ slug: 'no-such-restaurant' })
        .expect(404);
    });

    it('requires authentication', async () => {
      await seedUnclaimedListing(ctx, 'sandhya-s-kitchen');
      await mutate(ctx, 'post', '/api/v1/restaurants/claim')
        .send({ slug: 'sandhya-s-kitchen' })
        .expect(401);
    });
  });

  describe('GET/PATCH /restaurant/profile (tenant-scoped)', () => {
    async function createRestaurant(cookie: string, name = 'Spice Route') {
      const res = await mutate(ctx, 'post', '/api/v1/restaurants', cookie)
        .send({ name })
        .expect(201);
      return res.body.data as { id: string };
    }

    it('an OWNER can read and update their own profile, including nested address', async () => {
      const owner = await registerAndLogin(ctx);
      await createRestaurant(owner.cookie);

      const before = await get(ctx, '/api/v1/restaurant/profile', owner.cookie).expect(200);
      expect(before.body.data.name).toBe('Spice Route');
      expect(before.body.data.address).toBeNull();

      const updated = await mutate(ctx, 'patch', '/api/v1/restaurant/profile', owner.cookie)
        .send({
          description: 'Authentic South Indian food',
          address: {
            line1: '123 MG Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            postalCode: '560001',
          },
        })
        .expect(200);

      expect(updated.body.data.description).toBe('Authentic South Indian food');
      expect(updated.body.data.address).toMatchObject({ line1: '123 MG Road', city: 'Bengaluru' });

      const after = await get(ctx, '/api/v1/restaurant/profile', owner.cookie).expect(200);
      expect(after.body.data.address.postalCode).toBe('560001');
    });

    it('a STAFF member can read but not update the profile (403)', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurant = await createRestaurant(owner.cookie);
      const staffUser = await registerAndLogin(ctx);
      ctx.db.restaurantStaff.push({
        id: crypto.randomUUID(),
        userId: staffUser.userId,
        restaurantId: restaurant.id,
        role: 'STAFF',
        status: 'ACTIVE',
        invitedByUserId: owner.userId,
        joinedAt: new Date(),
        disabledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await get(ctx, '/api/v1/restaurant/profile', staffUser.cookie).expect(200);
      await mutate(ctx, 'patch', '/api/v1/restaurant/profile', staffUser.cookie)
        .send({ description: 'hijacked' })
        .expect(403);
    });

    it("requesting another restaurant's profile via X-Restaurant-Id you don't belong to returns 403", async () => {
      const ownerA = await registerAndLogin(ctx);
      const ownerB = await registerAndLogin(ctx);
      const restaurantB = await createRestaurant(ownerB.cookie, 'Copper Kettle');
      await createRestaurant(ownerA.cookie, 'Spice Route');

      await get(ctx, '/api/v1/restaurant/profile', ownerA.cookie)
        .set('X-Restaurant-Id', restaurantB.id)
        .expect(403);
    });
  });

  describe('GET/PATCH /restaurant/branding', () => {
    it('upserts branding fields', async () => {
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);

      const before = await get(ctx, '/api/v1/restaurant/branding', owner.cookie).expect(200);
      expect(before.body.data).toBeNull();

      const updated = await mutate(ctx, 'patch', '/api/v1/restaurant/branding', owner.cookie)
        .send({ tagline: 'Taste of the South', themePrimaryColor: '#ff5722' })
        .expect(200);
      expect(updated.body.data.tagline).toBe('Taste of the South');
      expect(updated.body.data.themePrimaryColor).toBe('#ff5722');
    });

    it('rejects a non-hex color', async () => {
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);

      await mutate(ctx, 'patch', '/api/v1/restaurant/branding', owner.cookie)
        .send({ themePrimaryColor: 'not-a-color' })
        .expect(422);
    });
  });

  describe('GET/PATCH /restaurant/settings', () => {
    it('has sensible defaults immediately after restaurant creation (never 404s)', async () => {
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);

      const res = await get(ctx, '/api/v1/restaurant/settings', owner.cookie).expect(200);
      expect(res.body.data.minOrderAmountMinor).toBe('0');
      expect(res.body.data.acceptsOnlinePayment).toBe(false);
    });

    it('updates money fields as integer minor units, serialized as strings', async () => {
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);

      const res = await mutate(ctx, 'patch', '/api/v1/restaurant/settings', owner.cookie)
        .send({ minOrderAmountMinor: 20000, deliveryFeeMode: 'FLAT', deliveryFeeFlatMinor: 3000 })
        .expect(200);

      expect(res.body.data.minOrderAmountMinor).toBe('20000');
      expect(res.body.data.deliveryFeeFlatMinor).toBe('3000');
    });

    it('rejects a fractional money value', async () => {
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);

      await mutate(ctx, 'patch', '/api/v1/restaurant/settings', owner.cookie)
        .send({ minOrderAmountMinor: 100.5 })
        .expect(422);
    });
  });

  describe('POST /restaurant/onboarding/submit', () => {
    it('requires an address before submission is allowed', async () => {
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);

      await mutate(ctx, 'post', '/api/v1/restaurant/onboarding/submit', owner.cookie).expect(409);
    });

    it('moves DRAFT → PENDING_APPROVAL and onboardingStatus → COMPLETED once an address exists — backend-authoritative, not client state (docs/14-acceptance-criteria.md, Phase 5)', async () => {
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);
      await mutate(ctx, 'patch', '/api/v1/restaurant/profile', owner.cookie)
        .send({
          address: {
            line1: '123 MG Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            postalCode: '560001',
          },
        })
        .expect(200);

      const res = await mutate(
        ctx,
        'post',
        '/api/v1/restaurant/onboarding/submit',
        owner.cookie,
      ).expect(200);
      expect(res.body.data.status).toBe('PENDING_APPROVAL');
      expect(res.body.data.onboardingStatus).toBe('COMPLETED');

      // Re-reading from a fresh request proves this is server state, not
      // something only reflected in the submit response itself — a
      // client clearing localStorage cannot un-submit it.
      const profile = await get(ctx, '/api/v1/restaurant/profile', owner.cookie).expect(200);
      expect(profile.body.data.status).toBe('PENDING_APPROVAL');
    });

    it('cannot be submitted twice', async () => {
      const owner = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);
      await mutate(ctx, 'patch', '/api/v1/restaurant/profile', owner.cookie)
        .send({
          address: {
            line1: '123 MG Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            postalCode: '560001',
          },
        })
        .expect(200);
      await mutate(ctx, 'post', '/api/v1/restaurant/onboarding/submit', owner.cookie).expect(200);

      await mutate(ctx, 'post', '/api/v1/restaurant/onboarding/submit', owner.cookie).expect(409);
    });

    // ── Phase 21a: resubmit after rejection ──────────────────────────

    it('resubmits after rejection: REJECTED -> PENDING_APPROVAL, rejectionReason cleared, submittedAt refreshed', async () => {
      const owner = await registerAndLogin(ctx);
      const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);
      const restaurantId = created.body.data.id as string;
      await mutate(ctx, 'patch', '/api/v1/restaurant/profile', owner.cookie)
        .send({
          address: {
            line1: '123 MG Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            postalCode: '560001',
          },
        })
        .expect(200);
      await mutate(ctx, 'post', '/api/v1/restaurant/onboarding/submit', owner.cookie).expect(200);
      const firstSubmittedAt = ctx.db.restaurants.find((r) => r.id === restaurantId)!.submittedAt;

      // Simulates an admin rejection (admin.e2e.test.ts covers the endpoint itself).
      const row = ctx.db.restaurants.find((r) => r.id === restaurantId)!;
      row.status = 'REJECTED';
      row.decidedAt = new Date();
      row.rejectionReason = 'Address could not be verified';

      const before = await get(ctx, '/api/v1/restaurant/profile', owner.cookie).expect(200);
      expect(before.body.data.status).toBe('REJECTED');
      expect(before.body.data.rejectionReason).toBe('Address could not be verified');

      const res = await mutate(
        ctx,
        'post',
        '/api/v1/restaurant/onboarding/submit',
        owner.cookie,
      ).expect(200);
      expect(res.body.data.status).toBe('PENDING_APPROVAL');
      expect(res.body.data.rejectionReason).toBeNull();
      expect(new Date(res.body.data.submittedAt).getTime()).toBeGreaterThanOrEqual(
        firstSubmittedAt!.getTime(),
      );
    });

    it('cannot be submitted from ACTIVE (409) — only DRAFT and REJECTED are legal', async () => {
      const owner = await registerAndLogin(ctx);
      const created = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);
      await mutate(ctx, 'patch', '/api/v1/restaurant/profile', owner.cookie)
        .send({
          address: {
            line1: '123 MG Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            postalCode: '560001',
          },
        })
        .expect(200);
      // An address now exists, isolating this 409 to the status guard
      // specifically, not the (already separately tested) address guard.
      ctx.db.restaurants.find((r) => r.id === created.body.data.id)!.status = 'ACTIVE';

      await mutate(ctx, 'post', '/api/v1/restaurant/onboarding/submit', owner.cookie).expect(409);
    });
  });
});
