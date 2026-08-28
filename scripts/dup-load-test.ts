/**
 * Duplicate-restaurant / duplicate-order load test, requested by sash:
 * "create 10+ duplicate restaurants, place hundreds of duplicate
 * orders, check if the admin dashboard reflects them on time" — then
 * extended to drive those orders through the FULL lifecycle (accepted,
 * rejected, preparing, ready, out for delivery, delivered, cancelled),
 * not just PLACED, so every tile on the Admin Overview dashboard gets
 * real, varied data to check against — not just "Orders today".
 *
 * LOCAL / DEV ONLY. Guards against ever pointing at the production
 * Render deployment (see BASE_URL check below) — this creates a large
 * volume of throwaway data and deliberately clears local Redis rate
 * -limit counters to push volume through fast, neither of which should
 * ever touch a real environment.
 *
 * What it does:
 *   1. Creates N restaurants directly via Prisma (same shape as
 *      prisma/seed.ts's seedRestaurant — full menu, always-open hours,
 *      ACTIVE/orderingEnabled) named "LoadTest Duplicate 01..NN", all
 *      identical apart from slug/name, i.e. genuinely duplicate
 *      restaurants, not just duplicate orders.
 *   2. Places TOTAL_ORDERS guest orders round-robin across them via
 *      the REAL HTTP guest-checkout flow (cart -> checkout ->
 *      simulate-payment -> verify-payment) — the same path a real
 *      browser takes, not a direct DB insert.
 *   3. Drives EACH order to one of 8 target outcomes (round-robin, see
 *      `LIFECYCLE_TARGETS`) via the REAL restaurant-facing HTTP
 *      endpoints (`accept`/`reject`/`cancel`/`preparing`/`ready`),
 *      logged in as that restaurant's own seeded owner. The one
 *      exception: OUT_FOR_DELIVERY and DELIVERED are NOT reachable via
 *      HTTP from an external process — `MockDeliveryProvider`'s
 *      in-memory delivery-status state lives inside the running API
 *      server's own process, and only advances via `advanceStatus()`,
 *      a method only reachable in-process (e2e tests call it via
 *      `ctx.app.get(MockDeliveryProvider)`). A webhook POST from this
 *      script would just re-read the provider's never-advanced
 *      `CREATED` status and no-op. So for those two outcomes only,
 *      `forceDeliveryProgress()` writes `Order.status`/`deliveredAt`
 *      and matching `OrderStatusHistory` rows directly via Prisma —
 *      clearly a bypass of `OrderStateService`, called out as such,
 *      and used ONLY to populate realistic dashboard data, not to
 *      exercise the delivery integration itself.
 *   4. Logs in as the seeded SUPER_ADMIN (TOTP computed from the
 *      seeded MFA secret, no manual code entry needed) and polls
 *      GET /admin/overview/command-center every POLL_INTERVAL_MS,
 *      printing EVERY kpi tile (not just ordersToday/gmvToday) next to
 *      a live groupBy(status) count from the same Postgres the app
 *      uses, so a mismatch on ANY tile is visible directly — exactly
 *      the class of bug the 2026-08-25 IST/UTC boundary fix caught.
 *
 * Run (from the repo root, with the dev API already running on
 * :4000 — `pnpm --filter=./apps/api run dev` in another terminal):
 *
 *   pnpm tsx --env-file=.env scripts/dup-load-test.ts
 *
 * Configurable via env vars:
 *   LOAD_TEST_BASE_URL      default http://localhost:4000
 *   LOAD_TEST_RESTAURANTS   default 12   (the "10+ duplicate restaurants")
 *   LOAD_TEST_ORDERS        default 300  (the "hundreds of duplicate orders")
 *   LOAD_TEST_POLL_MS       default 15000
 *   LOAD_TEST_POLL_MAX_MS   default 180000 (give up watching after 3 min)
 *
 * Cleanup: every restaurant this script creates has a slug starting
 * with `loadtest-duplicate-` and every owner email starts with
 * `loadtest`. See scripts/dup-load-test-cleanup.ts to remove them all
 * afterward.
 */
import { createHmac, randomUUID } from 'node:crypto';
import * as net from 'node:net';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { localMidnightToUtc, toLocalMoment } from '../apps/api/src/modules/availability/timezone.js';

// ── Safety guard ─────────────────────────────────────────────────
const BASE_URL = process.env.LOAD_TEST_BASE_URL ?? 'http://localhost:4000';
if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(BASE_URL)) {
  console.error(
    `[dup-load-test] Refusing to run against "${BASE_URL}" — this script only runs against ` +
      `a local host (localhost/127.0.0.1). It floods rate limits and creates hundreds of rows ` +
      `of throwaway data; it must never point at a deployed environment.`,
  );
  process.exit(1);
}

const RESTAURANT_COUNT = Number(process.env.LOAD_TEST_RESTAURANTS ?? 12);
const TOTAL_ORDERS = Number(process.env.LOAD_TEST_ORDERS ?? 300);
const POLL_INTERVAL_MS = Number(process.env.LOAD_TEST_POLL_MS ?? 15_000);
const POLL_MAX_MS = Number(process.env.LOAD_TEST_POLL_MAX_MS ?? 180_000);

const appDatabaseUrl = process.env.APP_DATABASE_URL;
if (!appDatabaseUrl) {
  console.error('[dup-load-test] APP_DATABASE_URL is required. Copy .env.example to .env first.');
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: appDatabaseUrl } } });

const DEMO_ADMIN_EMAIL = 'admin@direct-order.local';
const DEMO_ADMIN_PASSWORD = 'correct-horse-battery-staple-admin';
const DEMO_ADMIN_MFA_SECRET = 'M3MYO55TSBKAZBRDEDZ3TLHWLE4HCMJQ'; // matches prisma/seed.ts

// ── Minimal RFC 6238 TOTP (no extra dependency) ─────────────────────
function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of input.toUpperCase().replace(/=+$/, '')) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function totp(secretBase32: string, stepSeconds = 30, digits = 6, forTimeMs = Date.now()): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(forTimeMs / 1000 / stepSeconds);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binCode % 10 ** digits).padStart(digits, '0');
}

// ── Tiny cookie jar + fetch wrapper ─────────────────────────────────
class Session {
  private cookies = new Map<string, string>();

  private applySetCookie(headers: Headers): void {
    const raw =
      typeof (headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (headers as unknown as { getSetCookie(): string[] }).getSetCookie()
        : headers.get('set-cookie')
          ? [headers.get('set-cookie') as string]
          : [];
    for (const line of raw) {
      const pair = line.split(';')[0];
      if (!pair) continue;
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  private cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get csrfToken(): string | undefined {
    return this.cookies.get('do_csrf_token');
  }

  // `Omit<RequestInit, 'body'>` rather than a plain intersection — `&
  // { body?: unknown }` against `RequestInit`'s own `body?: BodyInit |
  // null` narrows right back down to `BodyInit | null` (intersecting
  // with `unknown` is a no-op), so a plain object literal was never
  // actually assignable despite how the type looked.
  //
  // Generic on the response shape (`T`, caller-supplied at each call
  // site) rather than `any` — an untyped API client here would push
  // `no-unsafe-member-access` onto every single call site instead of
  // being declared once, in one place, for a script whose whole job is
  // talking to this API.
  async request<T = unknown>(
    path: string,
    init: Omit<RequestInit, 'body'> & { body?: unknown } = {},
    isCsrfRetry = false,
  ): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {
      Cookie: this.cookieHeader(),
      ...(init.headers as Record<string, string> | undefined),
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.body);
    }
    if (method !== 'GET' && method !== 'HEAD') {
      headers['x-csrf-token'] = this.csrfToken ?? '';
    }
    const res = await fetch(`${BASE_URL}${path}`, { ...init, method, headers, body });
    // Runs unconditionally, ok or not — a request the CSRF guard REJECTS
    // still gets a fresh `do_csrf_token` cookie in its response (Nest's
    // cookie middleware runs before the guard), so a session's very
    // first mutating call always fails once, but sets up every call
    // after it to succeed. `/health` is NOT under `/api/v1` and never
    // goes through that middleware at all, so bootstrapping the token by
    // pre-hitting it (the previous approach) was a no-op — confirmed
    // live: it's exactly why the very first order and the one-shot
    // admin-login call both failed with "Missing or invalid CSRF token."
    this.applySetCookie(res.headers);
    const text = await res.text();
    const json = text ? (JSON.parse(text) as { data?: unknown; error?: { message?: string } }) : null;
    if (!res.ok) {
      if (res.status === 403 && !isCsrfRetry && /csrf/i.test(json?.error?.message ?? '')) {
        return this.request<T>(path, init, true);
      }
      throw new ApiCallError(`${method} ${path} -> ${res.status}: ${json?.error?.message ?? text}`, res.status, json);
    }
    return (json && 'data' in json ? json.data : json) as T;
  }
}

class ApiCallError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

// ── Redis rate-limit reset (local dev only — see class doc above) ──
function clearCheckoutRateLimit(): Promise<void> {
  const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const keys = [
    'ratelimit:CheckoutController.create:127.0.0.1',
    'ratelimit:CheckoutController.create:::1',
    'ratelimit:CheckoutController.create:::ffff:127.0.0.1',
  ];
  return new Promise((resolve) => {
    const socket = net.createConnection(
      { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) },
      () => {
        socket.write(`DEL ${keys.join(' ')}\r\n`);
      },
    );
    socket.on('data', () => {
      socket.end();
    });
    socket.on('error', () => resolve()); // best-effort — fine if this fails once
    socket.on('close', () => resolve());
    setTimeout(() => {
      socket.destroy();
      resolve();
    }, 2000);
  });
}

/** The full KPI shape — see admin-overview.controller.ts's `commandCenter()`. Checking every field here (not just ordersToday) is the whole point of this rewrite: a tile-specific bug (like the 2026-08-25 IST/UTC boundary one) only shows up if something actually reads every number. */
interface CommandCenterOverview {
  kpis: {
    ordersToday: number;
    ordersYesterday: number | null;
    ordersThisWeek: number;
    gmvTodayMinor: string;
    gmvYesterdayMinor: string | null;
    gmvThisWeekMinor: string;
    platformFeeRevenueTodayMinor: string;
    platformFeeRevenueYesterdayMinor: string | null;
    platformFeeRevenueThisWeekMinor: string;
    refundMinorToday: string;
    restaurantsLive: number;
    restaurantsPendingApproval: number;
  };
  funnel: Record<string, number>;
}

// ── Step 1: create N duplicate restaurants directly via Prisma ─────
interface CreatedRestaurant {
  id: string;
  slug: string;
  name: string;
  ownerEmail: string;
  items: Array<{ id: string; priceMinor: bigint }>;
}

async function createDuplicateRestaurants(count: number): Promise<CreatedRestaurant[]> {
  const passwordHash = await argon2.hash('loadtest-owner-password', {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  const created: CreatedRestaurant[] = [];
  for (let n = 1; n <= count; n++) {
    const suffix = String(n).padStart(2, '0');
    const slug = `loadtest-duplicate-${suffix}`;
    const name = `LoadTest Duplicate ${suffix}`;
    const ownerEmail = `loadtest-owner-${suffix}@direct-order.local`;

    const owner = await prisma.user.upsert({
      where: { email: ownerEmail },
      update: {},
      create: { email: ownerEmail, fullName: `LoadTest Owner ${suffix}`, passwordHash, emailVerifiedAt: new Date() },
    });

    const restaurant = await prisma.restaurant.upsert({
      where: { slug },
      update: { status: 'ACTIVE', orderingEnabled: true },
      create: {
        slug,
        name,
        description: 'Load-test duplicate restaurant — safe to delete, see scripts/dup-load-test-cleanup.ts.',
        status: 'ACTIVE',
        onboardingStatus: 'COMPLETED',
        orderingEnabled: true,
        address: { create: { line1: '1 Load Test Road', city: 'Bengaluru', state: 'Karnataka', postalCode: '560001' } },
        branding: { create: { tagline: 'Load-test duplicate restaurant' } },
        settings: { create: { acceptsOnlinePayment: false } },
      },
    });

    await prisma.restaurantStaff.upsert({
      where: { userId_restaurantId: { userId: owner.id, restaurantId: restaurant.id } },
      update: {},
      create: { userId: owner.id, restaurantId: restaurant.id, role: 'OWNER' },
    });

    const existingHours = await prisma.operatingHours.count({ where: { restaurantId: restaurant.id } });
    if (existingHours === 0) {
      await prisma.operatingHours.createMany({
        data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          restaurantId: restaurant.id,
          dayOfWeek,
          opensAt: new Date(Date.UTC(1970, 0, 1, 0, 0, 0)),
          closesAt: new Date(Date.UTC(1970, 0, 1, 23, 59, 0)),
          isClosed: false,
        })),
      });
    }

    let items = await prisma.menuItem.findMany({ where: { restaurantId: restaurant.id } });
    if (items.length === 0) {
      const category = await prisma.menuCategory.create({
        data: { restaurantId: restaurant.id, name: 'Load Test Items', displayOrder: 0 },
      });
      await prisma.menuItem.createMany({
        data: [
          { restaurantId: restaurant.id, categoryId: category.id, name: 'Load Test Item A', priceMinor: 10000n, displayOrder: 0 },
          { restaurantId: restaurant.id, categoryId: category.id, name: 'Load Test Item B', priceMinor: 15000n, displayOrder: 1 },
        ],
      });
      items = await prisma.menuItem.findMany({ where: { restaurantId: restaurant.id } });
    }

    created.push({
      id: restaurant.id,
      slug: restaurant.slug,
      name: restaurant.name,
      ownerEmail,
      items: items.map((i) => ({ id: i.id, priceMinor: i.priceMinor })),
    });
  }
  return created;
}

// ── Step 2: place one guest order via the real HTTP checkout flow ──
async function placeDuplicateOrder(session: Session, restaurant: CreatedRestaurant, index: number): Promise<string> {
  // Always non-empty — createDuplicateRestaurants seeds exactly 2 items per restaurant.
  const item = restaurant.items[index % restaurant.items.length]!;

  const cart = await session.request<{ cartId: string; guestToken: string }>('/api/v1/public/carts', {
    method: 'POST',
    body: {
      restaurantSlug: restaurant.slug,
      items: [{ itemId: item.id, quantity: 1, unitPriceMinorAtAdd: item.priceMinor.toString() }],
    },
  });

  const checkout = await session.request<{ orderNumber: string; accessToken: string }>(
    '/api/v1/public/checkout',
    {
      method: 'POST',
      headers: { 'idempotency-key': randomUUID() },
      body: {
        cartId: cart.cartId,
        guestToken: cart.guestToken,
        customer: { name: 'Duplicate LoadTest Customer', phone: '+919999999999' },
        deliveryAddress: { line1: '1 Load Test Road', city: 'Bengaluru', postalCode: '560001' },
      },
    },
  );

  const simulated = await session.request<{ providerPaymentId: string | null }>(
    `/api/v1/public/orders/${checkout.orderNumber}/simulate-payment`,
    { method: 'POST', body: { token: checkout.accessToken, outcome: 'CAPTURED' } },
  );

  // simulate-payment only makes the mock provider report CAPTURED — it
  // does NOT itself transition the order. `placedAt` (what the rollup's
  // ordersPlaced actually counts, per order-state.service.ts's
  // PENDING_PAYMENT -> PLACED timestampPatch) is only set here, on
  // verify-payment. Without this call every order stays stuck in
  // PENDING_PAYMENT forever and the dashboard would correctly show zero
  // growth — a false "rollup didn't catch up" result, not a real bug.
  await session.request(`/api/v1/public/orders/${checkout.orderNumber}/verify-payment`, {
    method: 'POST',
    body: { token: checkout.accessToken, providerPaymentId: simulated.providerPaymentId ?? undefined },
  });

  return checkout.orderNumber;
}

const LOADTEST_OWNER_PASSWORD = 'loadtest-owner-password'; // matches createDuplicateRestaurants

/** One session per restaurant owner, reused across every order for that restaurant — logging in once per restaurant, not once per order. */
const ownerSessions = new Map<string, Session>();

async function ownerSessionFor(restaurant: CreatedRestaurant): Promise<Session> {
  const existing = ownerSessions.get(restaurant.id);
  if (existing) return existing;
  const session = new Session();
  await session.request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: restaurant.ownerEmail, password: LOADTEST_OWNER_PASSWORD },
  });
  ownerSessions.set(restaurant.id, session);
  return session;
}

/**
 * The 8 outcomes this script spreads orders across, round-robin. Order
 * matters only in that it documents the intent — `driveOrderLifecycle`
 * below is what actually walks each one through the real state graph
 * (`ORDER_TRANSITIONS`, order-state.service.ts).
 */
const LIFECYCLE_TARGETS = [
  'PLACED', // no restaurant action — stays exactly where checkout left it
  'ACCEPTED',
  'REJECTED',
  'CANCELLED', // accepted, then cancelled — cancel() requires an accepted order (see driveOrderLifecycle)
  'PREPARING',
  'READY_FOR_PICKUP',
  'OUT_FOR_DELIVERY', // see forceDeliveryProgress's doc comment for why this one bypasses HTTP
  'DELIVERED', // same bypass, one hop further
] as const;
type LifecycleTarget = (typeof LIFECYCLE_TARGETS)[number];

async function restaurantOrderAction(
  session: Session,
  path: string,
  body?: Record<string, unknown>,
): Promise<void> {
  await session.request(path, {
    method: 'POST',
    headers: { 'idempotency-key': randomUUID() },
    ...(body ? { body } : {}),
  });
}

/**
 * `OUT_FOR_DELIVERY`/`DELIVERED` bypass `OrderStateService` entirely —
 * see this file's top doc comment for why (`MockDeliveryProvider`'s
 * delivery-status state is private to the running API process; this
 * script is a separate process and has no way to call its
 * HTTP-unreachable `advanceStatus()`). Writes the same fields
 * `OrderStateService.transition()`'s own `timestampPatch()` would, and
 * inserts matching `OrderStatusHistory` rows so downstream queries that
 * read history (e.g. the rollup's `ordersRejected` count) stay
 * consistent — but this is still a deliberate shortcut, not a
 * substitute for testing the real delivery integration.
 */
async function forceDeliveryProgress(orderId: string, target: 'OUT_FOR_DELIVERY' | 'DELIVERED'): Promise<void> {
  await prisma.order.update({ where: { id: orderId }, data: { status: 'OUT_FOR_DELIVERY' } });
  await prisma.orderStatusHistory.create({
    data: { orderId, fromStatus: 'READY_FOR_PICKUP', toStatus: 'OUT_FOR_DELIVERY', actorType: 'SYSTEM' },
  });
  if (target === 'DELIVERED') {
    await prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    await prisma.orderStatusHistory.create({
      data: { orderId, fromStatus: 'OUT_FOR_DELIVERY', toStatus: 'DELIVERED', actorType: 'SYSTEM' },
    });
  }
}

/** Drives one already-PLACED order to its assigned target outcome, via real restaurant HTTP endpoints wherever the API surface allows it. */
async function driveOrderLifecycle(restaurant: CreatedRestaurant, orderId: string, target: LifecycleTarget): Promise<void> {
  if (target === 'PLACED') return;

  const session = await ownerSessionFor(restaurant);
  const base = `/api/v1/restaurant/orders/${orderId}`;

  if (target === 'REJECTED') {
    // reject() is specifically for a still-PLACED order — cancel() is
    // post-accept only (confirmed live: cancel() 409s on a PLACED order
    // with "has not been accepted yet — use reject()"), a stricter rule
    // than ORDER_TRANSITIONS' raw graph alone would suggest.
    await restaurantOrderAction(session, `${base}/reject`, { reason: 'Load test simulated rejection.' });
    return;
  }

  // Every remaining target needs at least ACCEPTED first — including
  // CANCELLED, which despite PLACED -> CANCELLED being a legal edge in
  // ORDER_TRANSITIONS, is only reachable via the real cancel() endpoint
  // once accepted (see the REJECTED comment above).
  await restaurantOrderAction(session, `${base}/accept`);
  if (target === 'ACCEPTED') return;
  if (target === 'CANCELLED') {
    await restaurantOrderAction(session, `${base}/cancel`, { reason: 'Load test simulated cancellation.' });
    return;
  }

  await restaurantOrderAction(session, `${base}/preparing`);
  if (target === 'PREPARING') return;

  await restaurantOrderAction(session, `${base}/ready`); // auto-creates a Delivery row via DeliveryDispatchService
  if (target === 'READY_FOR_PICKUP') return;

  await forceDeliveryProgress(orderId, target); // OUT_FOR_DELIVERY or DELIVERED
}

// ── Step 3: admin login + MFA, then poll the dashboard ──────────────
async function loginAsSuperAdmin(session: Session): Promise<void> {
  await session.request('/api/v1/auth/login', {
    method: 'POST',
    body: { email: DEMO_ADMIN_EMAIL, password: DEMO_ADMIN_PASSWORD },
  });
  await session.request('/api/v1/auth/mfa/verify', {
    method: 'POST',
    body: { code: totp(DEMO_ADMIN_MFA_SECRET) },
  });
}

async function main(): Promise<void> {
  console.log(`[dup-load-test] target: ${BASE_URL}`);
  console.log(`[dup-load-test] creating ${RESTAURANT_COUNT} duplicate restaurants...`);
  const restaurants = await createDuplicateRestaurants(RESTAURANT_COUNT);
  console.log(`[dup-load-test] created/verified: ${restaurants.map((r) => r.slug).join(', ')}`);

  const restaurantIds = restaurants.map((r) => r.id);
  const beforeCount = await prisma.order.count({ where: { restaurantId: { in: restaurantIds } } });

  console.log(
    `[dup-load-test] placing ${TOTAL_ORDERS} duplicate orders across them, each driven to one of ` +
      `${LIFECYCLE_TARGETS.length} lifecycle outcomes (${LIFECYCLE_TARGETS.join(', ')})...`,
  );
  const orderSession = new Session();
  let placed = 0;
  let placeFailed = 0;
  let lifecycleFailed = 0;
  const startedAt = Date.now();
  for (let i = 0; i < TOTAL_ORDERS; i++) {
    if (i % 15 === 0) await clearCheckoutRateLimit(); // stay under the real 20/hour anti-abuse limit without weakening it in code
    const restaurant = restaurants[i % restaurants.length]!; // always non-empty — RESTAURANT_COUNT >= 1
    const target = LIFECYCLE_TARGETS[i % LIFECYCLE_TARGETS.length]!;
    try {
      const orderNumber = await placeDuplicateOrder(orderSession, restaurant, i);
      placed++;
      try {
        const order = await prisma.order.findUnique({ where: { orderNumber }, select: { id: true } });
        await driveOrderLifecycle(restaurant, order!.id, target);
      } catch (error) {
        lifecycleFailed++;
        if (lifecycleFailed <= 5) {
          console.error(`[dup-load-test] order ${i} (${orderNumber} -> ${target}) lifecycle step failed: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      placeFailed++;
      if (placeFailed <= 5) {
        console.error(`[dup-load-test] order ${i} placement failed: ${(error as Error).message}`);
      }
    }
    if ((i + 1) % 25 === 0) {
      console.log(
        `[dup-load-test]   ${i + 1}/${TOTAL_ORDERS} attempted (${placed} placed, ${placeFailed} placement failures, ${lifecycleFailed} lifecycle failures)`,
      );
    }
  }
  // eslint-disable-next-line no-restricted-syntax -- not money: elapsed seconds
  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[dup-load-test] done: ${placed} placed, ${placeFailed} placement failures, ${lifecycleFailed} lifecycle failures, in ${elapsedSeconds}s`,
  );

  const afterCount = await prisma.order.count({ where: { restaurantId: { in: restaurantIds } } });
  const realNewOrders = afterCount - beforeCount;
  console.log(`[dup-load-test] real DB order count for these restaurants: ${beforeCount} -> ${afterCount} (+${realNewOrders})`);

  console.log('[dup-load-test] logging in as super admin to watch the dashboard...');
  const adminSession = new Session();
  await loginAsSuperAdmin(adminSession);

  // Ground truth for OUR OWN restaurants only — useful for confirming
  // this run's own orders landed correctly.
  const ourGmv = await prisma.order.aggregate({
    where: { restaurantId: { in: restaurantIds }, placedAt: { not: null } },
    _sum: { payableTotalMinor: true },
  });
  console.log(
    `[dup-load-test] ground truth for THESE restaurants only: ${placed} orders placed, ` +
      `gross value ${(ourGmv._sum.payableTotalMinor ?? 0n).toString()} minor units`,
  );

  // The dashboard's ordersToday/gmvTodayMinor are PLATFORM-WIDE, not
  // scoped to these restaurants — this local dev DB has ~120+ other
  // restaurants from unrelated testing, so comparing the dashboard
  // against restaurant-scoped ground truth alone would flag a false
  // "mismatch" the moment ANY other same-day activity exists.
  //
  // `Order.placedAt` is a REAL timestamp, so the boundary against it
  // must be the actual IST-midnight INSTANT (`localMidnightToUtc` —
  // same function `startOfTodayIst()` uses, and the same one `funnel`
  // above is already queried with), NOT `dateKeyToUtcDate` (a literal
  // date-KEY label, only correct against `DailyPlatformMetrics.date`).
  // Conflating the two here would reproduce, in this verification
  // script, the exact bug admin-overview.controller.ts's commandCenter()
  // was just fixed for — confirmed live: an earlier version of this
  // exact line using `dateKeyToUtcDate` reported "0 orders" moments
  // after this run had genuinely placed 24.
  const platformTodayKey = toLocalMoment(new Date(), 'Asia/Kolkata').dateKey;
  const platformTodayStart = localMidnightToUtc(platformTodayKey, 'Asia/Kolkata');
  const platformTomorrowStart = new Date(platformTodayStart.getTime() + 24 * 60 * 60 * 1000);
  const platformToday = await prisma.order.aggregate({
    where: { placedAt: { gte: platformTodayStart, lt: platformTomorrowStart } },
    _count: true,
    _sum: { payableTotalMinor: true },
  });
  console.log(
    `[dup-load-test] platform-wide ground truth for today (${platformTodayKey}, ALL restaurants): ` +
      `${platformToday._count} orders, gross value ${(platformToday._sum.payableTotalMinor ?? 0n).toString()} minor units`,
  );

  console.log(
    `[dup-load-test] polling GET /admin/overview/command-center every ${POLL_INTERVAL_MS / 1000}s ` +
      `for up to ${POLL_MAX_MS / 1000}s, printing EVERY kpi tile plus the lifecycle funnel...`,
  );
  const pollStart = Date.now();
  let matchedAt: number | null = null;
  let lastOverview: CommandCenterOverview | null = null;
  while (Date.now() - pollStart < POLL_MAX_MS) {
    const overview = await adminSession.request<CommandCenterOverview>('/api/v1/admin/overview/command-center');
    lastOverview = overview;
    // eslint-disable-next-line no-restricted-syntax -- not money: elapsed seconds
    const elapsed = ((Date.now() - pollStart) / 1000).toFixed(0);
    console.log(`[dup-load-test]   t+${elapsed}s kpis:`, overview.kpis);
    console.log(`[dup-load-test]   t+${elapsed}s funnel:`, overview.funnel);
    if (matchedAt === null && overview.kpis.ordersToday >= placed && placed > 0) {
      matchedAt = Date.now() - pollStart;
      console.log(
        // eslint-disable-next-line no-restricted-syntax -- not money: elapsed seconds
        `[dup-load-test]   ^ dashboard ordersToday caught up to (or exceeded) live truth at t+${(matchedAt / 1000).toFixed(0)}s`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  const liveStatusBreakdown = await prisma.order.groupBy({
    by: ['status'],
    where: { restaurantId: { in: restaurantIds } },
    _count: true,
  });

  console.log('\n[dup-load-test] SUMMARY');
  console.log(`  restaurants created:         ${restaurants.length}`);
  console.log(`  orders attempted:            ${TOTAL_ORDERS}`);
  console.log(`  orders placed:               ${placed}`);
  console.log(`  placement failures:          ${placeFailed}`);
  console.log(`  lifecycle-step failures:     ${lifecycleFailed}`);
  console.log(`  real DB orders added:        ${realNewOrders}`);
  console.log('  live status breakdown (ground truth, straight from Postgres):');
  for (const row of liveStatusBreakdown) console.log(`    ${row.status.padEnd(16)} ${row._count}`);
  console.log(
    matchedAt !== null
      ? // eslint-disable-next-line no-restricted-syntax -- not money: elapsed seconds
        `  dashboard ordersToday caught up in: ~${(matchedAt / 1000).toFixed(0)}s`
      : `  dashboard ordersToday did NOT catch up within ${POLL_MAX_MS / 1000}s — investigate AnalyticsRollupService / ROLLUP_CHECK_INTERVAL_MS`,
  );
  if (lastOverview) {
    // Re-fetched here, not reused from before the poll loop — other
    // activity on this shared dev DB (a browser tab, another script)
    // could have placed more orders while this ran, and that's not a
    // bug to flag, just what "platform-wide, live" means.
    const platformNow = await prisma.order.aggregate({
      where: { placedAt: { gte: platformTodayStart, lt: platformTomorrowStart } },
      _sum: { payableTotalMinor: true },
    });
    const expectedGmvNow = (platformNow._sum.payableTotalMinor ?? 0n).toString();
    const gmvMatches = lastOverview.kpis.gmvTodayMinor === expectedGmvNow;
    console.log(
      `  dashboard gmvTodayMinor:    ${lastOverview.kpis.gmvTodayMinor} ` +
        `(platform-wide truth right now: ${expectedGmvNow}) — ${gmvMatches ? 'MATCH' : 'MISMATCH — investigate, unless something else placed an order on this DB in the last few seconds'}`,
    );
    console.log(`  dashboard funnel vs. live status breakdown — compare the two tables above by eye for any tile that's off.`);
  }
  console.log('\n  Cleanup: pnpm tsx --env-file=.env scripts/dup-load-test-cleanup.ts');
}

main()
  .catch((error) => {
    console.error('[dup-load-test] fatal:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
