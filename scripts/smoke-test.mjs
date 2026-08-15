#!/usr/bin/env node
// docs/10-infrastructure-deployment.md §17.3, deploy sequence step 6:
// "Smoke tests." docs/14-acceptance-criteria.md Phase 20: "Smoke tests
// pass against production." This script is written to run against ANY
// base URL (local dev, staging, or real production once one exists) —
// it takes no shortcuts specific to the local environment other than
// its default target.
//
// Existing CI (`live-database-smoke-test` in .github/workflows/ci.yml)
// only checks /health and /ready. This is broader: it exercises one
// real read path per major surface (public browsing, admin auth) so a
// "smoke test passed" claim means more than "the process is up."
//
// Read-only except for login (which is itself the point — proving
// authentication actually works end to end). No orders are created, no
// money moves, nothing is mutated.

import { createHmac } from 'node:crypto';

const BASE_URL = process.env.SMOKE_TEST_BASE_URL ?? 'http://localhost:4000';
const RESTAURANT_SLUG = process.env.SMOKE_TEST_RESTAURANT_SLUG ?? 'spice-route';
// Dev/pilot-only seeded credentials (prisma/seed.ts) — never real
// production credentials. A real production run must set these via env
// vars instead, and `db:seed` must never run against production per
// seed.ts's own documented warning.
const ADMIN_EMAIL = process.env.SMOKE_TEST_ADMIN_EMAIL ?? 'admin@direct-order.local';
const ADMIN_PASSWORD =
  process.env.SMOKE_TEST_ADMIN_PASSWORD ?? 'correct-horse-battery-staple-admin';
const ADMIN_MFA_SECRET =
  process.env.SMOKE_TEST_ADMIN_MFA_SECRET ?? 'DIRECTORDERSUPERADMINMFASECRET';

const results = [];

function record(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
}

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of input.toUpperCase().replace(/=+$/, '')) {
    const val = alphabet.indexOf(c);
    if (val === -1) continue;
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret, stepSeconds = 30, digits = 6) {
  const key = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / stepSeconds);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    (((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff)) %
    10 ** digits;
  return code.toString().padStart(digits, '0');
}

class CookieJar {
  #cookies = new Map();

  absorb(response) {
    const raw = response.headers.getSetCookie?.() ?? response.headers.get('set-cookie');
    const headers = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const header of headers) {
      const [pair] = header.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      this.#cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header() {
    return [...this.#cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name) {
    return this.#cookies.get(name);
  }
}

async function main() {
  console.log(`=== Phase 20 smoke test ===`);
  console.log(`Target: ${BASE_URL}\n`);

  console.log('Liveness and readiness:');
  const health = await fetch(`${BASE_URL}/health`);
  record('GET /health returns 200', health.status === 200, `status=${health.status}`);
  const ready = await fetch(`${BASE_URL}/ready`);
  record('GET /ready returns 200 (database + Redis reachable)', ready.status === 200, `status=${ready.status}`);

  console.log('\nPublic browsing surface (unauthenticated):');
  const profile = await fetch(`${BASE_URL}/api/v1/public/restaurants/${RESTAURANT_SLUG}`);
  const profileBody = await profile.json().catch(() => null);
  record(
    'GET /public/restaurants/:slug returns a restaurant profile',
    profile.status === 200 && profileBody?.data?.slug === RESTAURANT_SLUG,
    `status=${profile.status}`,
  );
  const menu = await fetch(`${BASE_URL}/api/v1/public/restaurants/${RESTAURANT_SLUG}/menu`);
  const menuBody = await menu.json().catch(() => null);
  record(
    'GET /public/restaurants/:slug/menu returns categories',
    menu.status === 200 && Array.isArray(menuBody?.data?.categories),
    `status=${menu.status}`,
  );

  console.log('\nSecurity headers present on a real response:');
  record('CSP header present', profile.headers.has('content-security-policy'));
  record('HSTS header present', profile.headers.has('strict-transport-security'));

  console.log('\nAdmin authentication (full login + MFA + an authorized read):');
  const jar = new CookieJar();
  const prime = await fetch(`${BASE_URL}/health`);
  jar.absorb(prime);
  const csrfToken = jar.get('do_csrf_token');
  if (!csrfToken) {
    record('CSRF cookie issued', false, 'no do_csrf_token cookie on response');
  } else {
    record('CSRF cookie issued', true);

    const login = await fetch(`${BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': csrfToken,
        cookie: jar.header(),
      },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    jar.absorb(login);
    record('POST /auth/login succeeds with seeded admin credentials', login.status === 200, `status=${login.status}`);

    if (login.status === 200) {
      const code = totp(ADMIN_MFA_SECRET);
      const mfa = await fetch(`${BASE_URL}/api/v1/auth/mfa/verify`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrfToken,
          cookie: jar.header(),
        },
        body: JSON.stringify({ code }),
      });
      jar.absorb(mfa);
      record('POST /auth/mfa/verify succeeds with a computed TOTP code', mfa.status === 200, `status=${mfa.status}`);

      if (mfa.status === 200) {
        const health2 = await fetch(`${BASE_URL}/api/v1/admin/system-health`, {
          headers: { cookie: jar.header() },
        });
        const health2Body = await health2.json().catch(() => null);
        record(
          'GET /admin/system-health succeeds for an authenticated, MFA-verified admin',
          health2.status === 200 && typeof health2Body?.data?.overall === 'string',
          `status=${health2.status}${health2Body?.data ? `, overall=${health2Body.data.overall}` : ''}`,
        );
      }
    }
  }

  console.log('\n=== Summary ===');
  const failed = results.filter((r) => !r.passed);
  console.log(`${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log('Failed checks:');
    for (const f of failed) console.log(`  - ${f.name}`);
    process.exit(1);
  }
  console.log('All smoke tests passed.');
}

main().catch((error) => {
  console.error('Smoke test errored:', error);
  process.exit(1);
});
