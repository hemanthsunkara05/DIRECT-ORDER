import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/create-test-app.js';
import { mutate, registerAndLogin } from './support/register-and-login.js';

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const EXE_BYTES = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);

describe('Uploads (Phase 5, e2e)', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await createTestApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  async function createRestaurantAndCookie() {
    const owner = await registerAndLogin(ctx);
    await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
      .send({ name: 'Spice Route' })
      .expect(201);
    return owner.cookie;
  }

  describe('POST /restaurant/uploads/presign', () => {
    it('issues a presigned URL and a server-generated key for a valid JPEG declaration', async () => {
      const cookie = await createRestaurantAndCookie();

      const res = await mutate(ctx, 'post', '/api/v1/restaurant/uploads/presign', cookie)
        .send({ contentType: 'image/jpeg', sizeBytes: 100_000 })
        .expect(200);

      expect(res.body.data.key).toMatch(/^restaurants\/.+\.jpg$/);
      expect(res.body.data.uploadUrl).toEqual(expect.any(String));
      expect(res.body.data.publicUrl).toContain(res.body.data.key);
    });

    it('rejects SVG outright (docs/14-acceptance-criteria.md, Phase 5)', async () => {
      const cookie = await createRestaurantAndCookie();
      const res = await mutate(ctx, 'post', '/api/v1/restaurant/uploads/presign', cookie)
        .send({ contentType: 'image/svg+xml', sizeBytes: 1000 })
        .expect(422);
      expect(res.body.error.message).toMatch(/svg/i);
    });

    it('rejects a file over the size limit (docs/14-acceptance-criteria.md: "a 10 MB file ... is rejected")', async () => {
      const cookie = await createRestaurantAndCookie();
      const TEN_MB = 10 * 1024 * 1024;
      await mutate(ctx, 'post', '/api/v1/restaurant/uploads/presign', cookie)
        .send({ contentType: 'image/jpeg', sizeBytes: TEN_MB })
        .expect(422);
    });

    it('rejects an unsupported content type', async () => {
      const cookie = await createRestaurantAndCookie();
      await mutate(ctx, 'post', '/api/v1/restaurant/uploads/presign', cookie)
        .send({ contentType: 'application/pdf', sizeBytes: 1000 })
        .expect(422);
    });

    it('requires restaurant:branding permission — STAFF is denied', async () => {
      const owner = await registerAndLogin(ctx);
      const res = await mutate(ctx, 'post', '/api/v1/restaurants', owner.cookie)
        .send({ name: 'Spice Route' })
        .expect(201);
      const restaurantId = res.body.data.id as string;
      const staffUser = await registerAndLogin(ctx);
      ctx.db.restaurantStaff.push({
        id: crypto.randomUUID(),
        userId: staffUser.userId,
        restaurantId,
        role: 'STAFF',
        status: 'ACTIVE',
        invitedByUserId: owner.userId,
        joinedAt: new Date(),
        disabledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await mutate(ctx, 'post', '/api/v1/restaurant/uploads/presign', staffUser.cookie)
        .send({ contentType: 'image/jpeg', sizeBytes: 1000 })
        .expect(403);
    });
  });

  describe('POST /restaurant/uploads/verify (post-upload content verification, docs/09-security.md §15.6)', () => {
    it('verifies successfully when the uploaded bytes match the declared type', async () => {
      const cookie = await createRestaurantAndCookie();
      const presign = await mutate(ctx, 'post', '/api/v1/restaurant/uploads/presign', cookie)
        .send({ contentType: 'image/jpeg', sizeBytes: JPEG_BYTES.length })
        .expect(200);

      ctx.storage.seed(presign.body.data.key, JPEG_BYTES);

      await mutate(ctx, 'post', '/api/v1/restaurant/uploads/verify', cookie)
        .send({ key: presign.body.data.key, contentType: 'image/jpeg' })
        .expect(200);
    });

    it('rejects and deletes a .exe renamed to .jpg — the whole reason content verification exists (docs/14-acceptance-criteria.md, Phase 5)', async () => {
      const cookie = await createRestaurantAndCookie();
      const presign = await mutate(ctx, 'post', '/api/v1/restaurant/uploads/presign', cookie)
        .send({ contentType: 'image/jpeg', sizeBytes: EXE_BYTES.length })
        .expect(200);

      // The presign step only validates the DECLARED type — nothing
      // stops the client from uploading different bytes than it said it
      // would, which is exactly the attack this step defends against.
      ctx.storage.seed(presign.body.data.key, EXE_BYTES);

      const res = await mutate(ctx, 'post', '/api/v1/restaurant/uploads/verify', cookie)
        .send({ key: presign.body.data.key, contentType: 'image/jpeg' })
        .expect(422);
      expect(res.body.error.message).toMatch(/does not match/i);

      // The mismatched object is deleted, not left in the bucket.
      expect(ctx.storage.has(presign.body.data.key)).toBe(false);
      expect(
        ctx.db.auditLogs.some((entry) => entry.action === 'UPLOAD_CONTENT_MISMATCH_REJECTED'),
      ).toBe(true);
    });

    it('returns 404 if nothing was ever uploaded to that key', async () => {
      const cookie = await createRestaurantAndCookie();
      const presign = await mutate(ctx, 'post', '/api/v1/restaurant/uploads/presign', cookie)
        .send({ contentType: 'image/jpeg', sizeBytes: 1000 })
        .expect(200);

      await mutate(ctx, 'post', '/api/v1/restaurant/uploads/verify', cookie)
        .send({ key: presign.body.data.key, contentType: 'image/jpeg' })
        .expect(404);
    });

    it("rejects verifying a key outside the caller's own restaurant namespace", async () => {
      const cookieA = await createRestaurantAndCookie();
      const cookieB = await createRestaurantAndCookie();
      const presignB = await mutate(ctx, 'post', '/api/v1/restaurant/uploads/presign', cookieB)
        .send({ contentType: 'image/jpeg', sizeBytes: JPEG_BYTES.length })
        .expect(200);
      ctx.storage.seed(presignB.body.data.key, JPEG_BYTES);

      await mutate(ctx, 'post', '/api/v1/restaurant/uploads/verify', cookieA)
        .send({ key: presignB.body.data.key, contentType: 'image/jpeg' })
        .expect(403);
    });
  });
});
