/**
 * Development seed script (Phase 2). Creates two restaurants with
 * distinct owners and staff from day one, per
 * PRODUCT/docs/13-implementation-phases.md Phase 2 — "so isolation is
 * testable from the start." Every future phase's manual testing of
 * tenant isolation (docs/05-authorization-matrix.md §9.4) can start
 * from this data rather than creating fixtures from scratch each time.
 *
 * Connects using APP_DATABASE_URL (the restricted runtime role), not
 * DATABASE_URL — seeded data represents what the running application
 * itself would create, not a migration-time operation
 * (see README.md "Database roles").
 *
 * Every seeded restaurant owner/staff user gets a real argon2id
 * password hash (`DEMO_STAFF_PASSWORD` below) and the platform's
 * seeded `SUPER_ADMIN` gets its own (`DEMO_ADMIN_PASSWORD`) — both
 * dev/pilot-only, logged to the console when this script runs, never
 * real production credentials. `db:seed` must never run against
 * production for exactly this reason.
 */
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';

const appDatabaseUrl = process.env.APP_DATABASE_URL;

if (!appDatabaseUrl) {
  console.error('[seed] APP_DATABASE_URL is required. Copy .env.example to .env first.');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: appDatabaseUrl } } });

interface SeedUser {
  email: string;
  fullName: string;
}

interface SeedMenuItem {
  name: string;
  description?: string;
  priceMinor: bigint;
}

interface SeedMenuCategory {
  name: string;
  items: SeedMenuItem[];
}

interface SeedRestaurant {
  slug: string;
  name: string;
  description: string;
  city: string;
  state: string;
  postalCode: string;
  owner: SeedUser;
  additionalStaff: Array<{ user: SeedUser; role: 'MANAGER' | 'STAFF' }>;
  menu: SeedMenuCategory[];
}

const RESTAURANTS: SeedRestaurant[] = [
  {
    slug: 'spice-route',
    name: 'Spice Route',
    description: 'South Indian home-style thali and dosa, family-run since 2010.',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560034',
    owner: { email: 'asha@spiceroute.example', fullName: 'Asha Rao' },
    additionalStaff: [
      { user: { email: 'vikram@spiceroute.example', fullName: 'Vikram Shetty' }, role: 'MANAGER' },
    ],
    menu: [
      {
        name: 'Thali',
        items: [
          { name: 'Veg Thali', description: 'Rice, sambar, rasam, two curries, curd, papad.', priceMinor: 18000n },
          { name: 'South Indian Combo', description: 'Idli, vada, and chutney.', priceMinor: 12000n },
        ],
      },
      {
        name: 'Dosas',
        items: [
          { name: 'Plain Dosa', priceMinor: 8000n },
          { name: 'Masala Dosa', description: 'Potato masala filling.', priceMinor: 10000n },
          { name: 'Rava Dosa', priceMinor: 12000n },
        ],
      },
      {
        name: 'Beverages',
        items: [
          { name: 'Filter Coffee', priceMinor: 4000n },
          { name: 'Buttermilk', priceMinor: 3000n },
        ],
      },
    ],
  },
  {
    slug: 'copper-kettle',
    name: 'Copper Kettle',
    description: 'North Indian tandoor and curries, dine-in and direct delivery.',
    city: 'Bengaluru',
    state: 'Karnataka',
    postalCode: '560095',
    owner: { email: 'rohan@copperkettle.example', fullName: 'Rohan Mehta' },
    additionalStaff: [
      { user: { email: 'priya@copperkettle.example', fullName: 'Priya Nair' }, role: 'STAFF' },
    ],
    menu: [
      {
        name: 'Tandoor',
        items: [
          { name: 'Tandoori Chicken (Half)', priceMinor: 28000n },
          { name: 'Paneer Tikka', priceMinor: 22000n },
        ],
      },
      {
        name: 'Curries',
        items: [
          { name: 'Butter Chicken', priceMinor: 32000n },
          { name: 'Dal Makhani', priceMinor: 18000n },
          { name: 'Paneer Butter Masala', priceMinor: 24000n },
        ],
      },
      {
        name: 'Breads',
        items: [
          { name: 'Butter Naan', priceMinor: 4000n },
          { name: 'Tandoori Roti', priceMinor: 2500n },
        ],
      },
    ],
  },
];

/**
 * `OperatingHours.opensAt`/`closesAt` are Postgres `TIME` columns —
 * Prisma round-trips them as a `Date` whose date part is a fixed epoch
 * and whose UTC hour/minute is the wall-clock time-of-day (see the
 * identical, more heavily documented `parseTimeOfDay` in
 * `apps/api/src/modules/availability/time-of-day.ts`, not imported
 * here to keep this standalone script free of a cross-app dependency
 * for one three-line helper).
 */
function timeOfDay(hhmm: string): Date {
  const [hours, minutes] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(1970, 0, 1, hours, minutes, 0, 0));
}

/**
 * Dev/pilot-only password for every seeded restaurant owner/staff user
 * (never a real production credential, same as `DEMO_ADMIN_PASSWORD`
 * below). Originally left unset here — this file predates Phase 3
 * (authentication); the doc comment above claiming "this seed data
 * cannot be used to log in" was accurate then and became stale once
 * real password-based login shipped. Fixed so the seeded restaurant
 * accounts are actually usable, matching the super admin's own pattern.
 */
const DEMO_STAFF_PASSWORD = 'correct-horse-battery-staple-staff';

async function upsertUser(user: SeedUser, passwordHash: string) {
  // `update` (not just `create`) sets the password too — this script
  // is re-run across a long-lived dev database that already has these
  // exact demo users from earlier manual testing (real registrations,
  // not prior seed runs), so a create-only password would silently
  // never apply to them. Idempotent and self-healing: `pnpm db:seed`
  // always leaves the documented demo password actually working.
  const fields = { fullName: user.fullName, passwordHash, emailVerifiedAt: new Date() };
  return prisma.user.upsert({
    where: { email: user.email },
    update: fields,
    create: { email: user.email, ...fields },
  });
}

async function seedRestaurant(spec: SeedRestaurant, passwordHash: string): Promise<void> {
  const owner = await upsertUser(spec.owner, passwordHash);

  const restaurant = await prisma.restaurant.upsert({
    where: { slug: spec.slug },
    update: {},
    create: {
      slug: spec.slug,
      name: spec.name,
      description: spec.description,
      status: 'ACTIVE',
      onboardingStatus: 'COMPLETED',
      orderingEnabled: true,
      address: {
        create: {
          line1: `123 ${spec.name} Road`,
          city: spec.city,
          state: spec.state,
          postalCode: spec.postalCode,
        },
      },
      branding: { create: { tagline: spec.description } },
      settings: { create: { acceptsOnlinePayment: false } },
    },
  });

  await prisma.restaurantStaff.upsert({
    where: { userId_restaurantId: { userId: owner.id, restaurantId: restaurant.id } },
    update: {},
    create: { userId: owner.id, restaurantId: restaurant.id, role: 'OWNER' },
  });

  for (const { user: staffUser, role } of spec.additionalStaff) {
    const staff = await upsertUser(staffUser, passwordHash);
    await prisma.restaurantStaff.upsert({
      where: { userId_restaurantId: { userId: staff.id, restaurantId: restaurant.id } },
      update: {},
      create: {
        userId: staff.id,
        restaurantId: restaurant.id,
        role,
        invitedByUserId: owner.id,
      },
    });
  }

  // Open every day, 00:00–23:59 (effectively always-open) — no unique
  // constraint exists on OperatingHours to upsert against, so this only
  // creates rows the first time (an empty schedule means "never open,"
  // per AvailabilityService.isWithinScheduledHours — found live: both
  // demo restaurants showed "Currently closed" with an empty menu
  // search because this table, like menu items below, was never
  // seeded). Deliberately not a realistic "09:00-22:00" business-hours
  // window — this is demo/dev data checked in a real restaurant
  // timezone (Asia/Kolkata) at whatever wall-clock time someone happens
  // to load the page, and a restaurant that's sometimes closed for
  // testing depending on time-of-day is a worse demo than one that's
  // simply always open.
  const existingHours = await prisma.operatingHours.count({ where: { restaurantId: restaurant.id } });
  if (existingHours === 0) {
    await prisma.operatingHours.createMany({
      data: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        restaurantId: restaurant.id,
        dayOfWeek,
        opensAt: timeOfDay('00:00'),
        closesAt: timeOfDay('23:59'),
        isClosed: false,
      })),
    });
  }

  // Same idempotency approach as hours: no unique constraint to upsert
  // against, so only seed the menu the first time a restaurant is
  // created, not on every re-run.
  const existingCategories = await prisma.menuCategory.count({
    where: { restaurantId: restaurant.id },
  });
  if (existingCategories === 0) {
    for (const [categoryIndex, category] of spec.menu.entries()) {
      const createdCategory = await prisma.menuCategory.create({
        data: { restaurantId: restaurant.id, name: category.name, displayOrder: categoryIndex },
      });
      await prisma.menuItem.createMany({
        data: category.items.map((item, itemIndex) => ({
          restaurantId: restaurant.id,
          categoryId: createdCategory.id,
          name: item.name,
          description: item.description,
          priceMinor: item.priceMinor,
          displayOrder: itemIndex,
        })),
      });
    }
  }

  const itemCount = spec.menu.reduce((sum, category) => sum + category.items.length, 0);
  console.log(
    `[seed] ${spec.name} (${spec.slug}): owner + ${spec.additionalStaff.length} staff, ${spec.menu.length} categories / ${itemCount} items, open daily`,
  );
}

/**
 * Bootstraps the platform's first SUPER_ADMIN (Phase 13). There is
 * deliberately no HTTP endpoint that creates an AdminUser — docs/04-
 * api-specification.md §8.7 has no such route, only
 * `POST /admin/users/:id/disable`, and self-service admin creation
 * would be a real privilege-escalation hole anyway (docs/05
 * §9.1). Seeding is the same bootstrap mechanism every other "who
 * creates the very first one" problem in this codebase uses (there is
 * no chicken here to lay the first egg).
 *
 * MFA is enrolled directly (`mfaSecret`/`mfaEnabledAt` set, bypassing
 * the normal enroll → confirm HTTP flow) with a FIXED, documented
 * secret so this account is actually usable for local testing without
 * scanning a QR code — never a real production credential, and a real
 * deployment must never seed this data (`db:seed` is dev/pilot tooling,
 * documented as such since Phase 2).
 */
const DEMO_ADMIN_EMAIL = 'admin@direct-order.local';
const DEMO_ADMIN_PASSWORD = 'correct-horse-battery-staple-admin';
/**
 * Base32, RFC 4648 alphabet only (A–Z, 2–7) — decodes to arbitrary
 * bytes used as the TOTP HMAC key; the string itself has no other
 * meaning. Must be a whole number of bytes (a multiple of 8 base32
 * characters, unpadded) — this codebase's own decoder is lenient and
 * silently drops leftover bits from a short string, but a real
 * third-party authenticator app validates strictly and rejects
 * anything else as malformed. The previous value here (30 chars, 150
 * bits) worked against this app's own /auth/mfa endpoints but could
 * never be entered into an actual authenticator app — found live when
 * trying to enroll it in one. 32 chars (160 bits, `TotpService.
 * generateSecret()`'s own output length) is what a real enrollment
 * would produce.
 */
const DEMO_ADMIN_MFA_SECRET = 'M3MYO55TSBKAZBRDEDZ3TLHWLE4HCMJQ';

async function seedSuperAdmin(): Promise<void> {
  const passwordHash = await argon2.hash(DEMO_ADMIN_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });

  const user = await prisma.user.upsert({
    where: { email: DEMO_ADMIN_EMAIL },
    update: {},
    create: {
      email: DEMO_ADMIN_EMAIL,
      fullName: 'Platform Admin',
      passwordHash,
      emailVerifiedAt: new Date(),
      mfaSecret: DEMO_ADMIN_MFA_SECRET,
      mfaEnabledAt: new Date(),
    },
  });

  await prisma.adminUser.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id, role: 'SUPER_ADMIN' },
  });

  console.log(
    `[seed] Super admin: ${DEMO_ADMIN_EMAIL} / ${DEMO_ADMIN_PASSWORD} (MFA secret: ${DEMO_ADMIN_MFA_SECRET} — dev/pilot only, never seed this in a real deployment)`,
  );
}

async function main(): Promise<void> {
  const staffPasswordHash = await argon2.hash(DEMO_STAFF_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 4,
  });
  for (const spec of RESTAURANTS) {
    await seedRestaurant(spec, staffPasswordHash);
  }
  await seedSuperAdmin();
  console.log(`[seed] Restaurant owner/staff password (dev/pilot only): ${DEMO_STAFF_PASSWORD}`);
  console.log(`[seed] Done. ${RESTAURANTS.length} restaurants seeded.`);
}

main()
  .catch((error: unknown) => {
    console.error('[seed] Failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
