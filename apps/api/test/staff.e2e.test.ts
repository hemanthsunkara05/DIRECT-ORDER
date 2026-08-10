import { randomUUID, createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import {
  get,
  mutate,
  registerAndLogin,
  type RegisteredUser,
} from './support/register-and-login.js';

describe('Staff invitations and management (Phase 5, e2e)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  async function createRestaurant(owner: RegisteredUser, name = 'Spice Route'): Promise<string> {
    const res = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name })
      .expect(201);
    return res.body.data.id as string;
  }

  function addMembership(
    userId: string,
    restaurantId: string,
    role: 'STAFF' | 'MANAGER' | 'OWNER',
    invitedByUserId: string,
  ) {
    ctx.db.restaurantStaff.push({
      id: randomUUID(),
      userId,
      restaurantId,
      role,
      status: 'ACTIVE',
      invitedByUserId,
      joinedAt: new Date(),
      disabledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  /**
   * The raw invitation token is never returned by any API response
   * (only its hash is persisted) — Phase 5 has no real email notifier
   * yet to capture it from either. Tests that need to accept an
   * invitation stamp a known token's hash directly onto the
   * already-created invitation row, the same way earlier phases' tests
   * seed known secrets directly where no capturing fake exists.
   */
  function stampKnownToken(email: string, restaurantId: string, rawToken: string) {
    const invitation = ctx.db.staffInvitations.find(
      (i) => i.email === email && i.restaurantId === restaurantId,
    )!;
    invitation.tokenHash = createHash('sha256').update(rawToken).digest('hex');
    return invitation;
  }

  describe('POST /restaurant/staff/invitations + POST /auth/invitations/accept', () => {
    it('an invited user can accept and gains tenant access with the invited role', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const invitee = await registerAndLogin(ctx);

      await mutate(ctx, 'post', '/api/v1/restaurant/staff/invitations', owner.cookie)
        .send({ email: invitee.email, role: 'MANAGER' })
        .expect(201);
      stampKnownToken(invitee.email, restaurantId, 'known-test-token-1234567890');

      const acceptRes = await mutate(ctx, 'post', '/api/v1/auth/invitations/accept', invitee.cookie)
        .send({ token: 'known-test-token-1234567890' })
        .expect(200);
      expect(acceptRes.body.data.restaurantId).toBe(restaurantId);

      const membership = ctx.db.restaurantStaff.find(
        (s) => s.userId === invitee.userId && s.restaurantId === restaurantId,
      );
      expect(membership?.role).toBe('MANAGER');
      expect(membership?.status).toBe('ACTIVE');

      // The invited user can now use tenant-scoped routes.
      await get(ctx, '/api/v1/restaurant/profile', invitee.cookie)
        .set('X-Restaurant-Id', restaurantId)
        .expect(200);
    });

    it('an invitation cannot be accepted twice (docs/14-acceptance-criteria.md, Phase 5)', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const invitee = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurant/staff/invitations', owner.cookie)
        .send({ email: invitee.email, role: 'STAFF' })
        .expect(201);
      stampKnownToken(invitee.email, restaurantId, 'reused-token-abc');

      await mutate(ctx, 'post', '/api/v1/auth/invitations/accept', invitee.cookie)
        .send({ token: 'reused-token-abc' })
        .expect(200);

      const second = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/auth/invitations/accept', second.cookie)
        .send({ token: 'reused-token-abc' })
        .expect(422);
    });

    it('an expired invitation cannot be accepted', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const invitee = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurant/staff/invitations', owner.cookie)
        .send({ email: invitee.email, role: 'STAFF' })
        .expect(201);
      const invitation = stampKnownToken(invitee.email, restaurantId, 'expired-token-xyz');
      invitation.expiresAt = new Date(Date.now() - 1000);

      await mutate(ctx, 'post', '/api/v1/auth/invitations/accept', invitee.cookie)
        .send({ token: 'expired-token-xyz' })
        .expect(422);
    });

    it('a revoked invitation cannot be accepted', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const invitee = await registerAndLogin(ctx);
      await mutate(ctx, 'post', '/api/v1/restaurant/staff/invitations', owner.cookie)
        .send({ email: invitee.email, role: 'STAFF' })
        .expect(201);
      const invitation = stampKnownToken(invitee.email, restaurantId, 'revoked-token-xyz');
      invitation.status = 'REVOKED';
      invitation.revokedAt = new Date();

      await mutate(ctx, 'post', '/api/v1/auth/invitations/accept', invitee.cookie)
        .send({ token: 'revoked-token-xyz' })
        .expect(422);
    });

    it('rejects acceptance by a logged-in user whose email does not match the invitation', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const invitee = await registerAndLogin(ctx, { email: 'invited@spiceroute.test' });
      await mutate(ctx, 'post', '/api/v1/restaurant/staff/invitations', owner.cookie)
        .send({ email: invitee.email, role: 'STAFF' })
        .expect(201);
      stampKnownToken(invitee.email, restaurantId, 'mismatch-token-xyz');

      const wrongUser = await registerAndLogin(ctx, { email: 'not-invited@spiceroute.test' });
      await mutate(ctx, 'post', '/api/v1/auth/invitations/accept', wrongUser.cookie)
        .send({ token: 'mismatch-token-xyz' })
        .expect(422);
    });

    it('only OWNER can send invitations — MANAGER gets 403', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const manager = await registerAndLogin(ctx);
      addMembership(manager.userId, restaurantId, 'MANAGER', owner.userId);

      await mutate(ctx, 'post', '/api/v1/restaurant/staff/invitations', manager.cookie)
        .send({ email: 'someone@spiceroute.test', role: 'STAFF' })
        .expect(403);
    });
  });

  describe('last-owner protection (docs/01-domain-model.md §5.2, docs/14-acceptance-criteria.md Phase 5)', () => {
    it('the sole OWNER cannot be demoted — returns 409 LAST_OWNER', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const staffRow = ctx.db.restaurantStaff.find(
        (s) => s.userId === owner.userId && s.restaurantId === restaurantId,
      )!;

      const res = await mutate(
        ctx,
        'patch',
        `/api/v1/restaurant/staff/${staffRow.id}/role`,
        owner.cookie,
      )
        .send({ role: 'MANAGER' })
        .expect(409);
      expect(res.body.error.code).toBe('LAST_OWNER');
    });

    it('the sole OWNER cannot disable themselves — returns 409 LAST_OWNER', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const staffRow = ctx.db.restaurantStaff.find(
        (s) => s.userId === owner.userId && s.restaurantId === restaurantId,
      )!;

      const res = await mutate(
        ctx,
        'delete',
        `/api/v1/restaurant/staff/${staffRow.id}`,
        owner.cookie,
      ).expect(409);
      expect(res.body.error.code).toBe('LAST_OWNER');
    });

    it('a second OWNER CAN be demoted or disabled once there are two', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const secondOwner = await registerAndLogin(ctx);
      addMembership(secondOwner.userId, restaurantId, 'OWNER', owner.userId);
      const secondStaffRow = ctx.db.restaurantStaff.find((s) => s.userId === secondOwner.userId)!;

      await mutate(ctx, 'patch', `/api/v1/restaurant/staff/${secondStaffRow.id}/role`, owner.cookie)
        .send({ role: 'MANAGER' })
        .expect(200);

      const updated = ctx.db.restaurantStaff.find((s) => s.id === secondStaffRow.id);
      expect(updated?.role).toBe('MANAGER');
    });
  });

  describe('disabling staff revokes sessions immediately', () => {
    it('a disabled staff member loses their existing session on the next request', async () => {
      const owner = await registerAndLogin(ctx);
      const restaurantId = await createRestaurant(owner);
      const staffUser = await registerAndLogin(ctx);
      addMembership(staffUser.userId, restaurantId, 'STAFF', owner.userId);
      const staffRow = ctx.db.restaurantStaff.find((s) => s.userId === staffUser.userId)!;

      await get(ctx, '/api/v1/auth/me', staffUser.cookie).expect(200);

      await mutate(ctx, 'delete', `/api/v1/restaurant/staff/${staffRow.id}`, owner.cookie).expect(
        200,
      );

      await get(ctx, '/api/v1/auth/me', staffUser.cookie).expect(401);
    });
  });

  describe('cross-restaurant staff management (docs/14-acceptance-criteria.md, Phase 5)', () => {
    it('an owner sending X-Restaurant-Id for a restaurant they do not belong to is 403, before any staff id is even considered', async () => {
      const ownerA = await registerAndLogin(ctx);
      await createRestaurant(ownerA, 'Spice Route');
      const ownerB = await registerAndLogin(ctx);
      const restaurantB = await createRestaurant(ownerB, 'Copper Kettle');
      const staffInB = ctx.db.restaurantStaff.find((s) => s.restaurantId === restaurantB)!;

      await mutate(ctx, 'patch', `/api/v1/restaurant/staff/${staffInB.id}/role`, ownerA.cookie)
        .set('X-Restaurant-Id', restaurantB)
        .send({ role: 'MANAGER' })
        .expect(403);
    });

    it("a staff id belonging to a different restaurant than the caller's own (implicitly resolved) tenant returns 404, not the resource", async () => {
      const ownerA = await registerAndLogin(ctx);
      await createRestaurant(ownerA, 'Spice Route');
      const ownerB = await registerAndLogin(ctx);
      const restaurantB = await createRestaurant(ownerB, 'Copper Kettle');
      const staffInB = ctx.db.restaurantStaff.find((s) => s.restaurantId === restaurantB)!;

      // ownerA belongs to exactly one restaurant (Spice Route), resolved
      // implicitly with no header — staffInB's id is real, but belongs
      // to a restaurant outside that resolved tenant.
      await mutate(ctx, 'patch', `/api/v1/restaurant/staff/${staffInB.id}/role`, ownerA.cookie)
        .send({ role: 'MANAGER' })
        .expect(404);
    });
  });
});
