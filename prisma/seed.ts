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
 * No password hashing yet: `passwordHash` is left null for every
 * seeded user. Real password hashing (argon2id) arrives in Phase 3
 * (authentication) — this seed data cannot be used to log in until
 * then, only to populate realistic tenant-scoped data for manual
 * inspection and future phases' isolation tests.
 */
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

interface SeedRestaurant {
  slug: string;
  name: string;
  description: string;
  city: string;
  state: string;
  postalCode: string;
  owner: SeedUser;
  additionalStaff: Array<{ user: SeedUser; role: 'MANAGER' | 'STAFF' }>;
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
  },
];

async function upsertUser(user: SeedUser) {
  return prisma.user.upsert({
    where: { email: user.email },
    update: {},
    create: { email: user.email, fullName: user.fullName },
  });
}

async function seedRestaurant(spec: SeedRestaurant): Promise<void> {
  const owner = await upsertUser(spec.owner);

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
    const staff = await upsertUser(staffUser);
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

  console.log(`[seed] ${spec.name} (${spec.slug}): owner + ${spec.additionalStaff.length} staff`);
}

async function main(): Promise<void> {
  for (const spec of RESTAURANTS) {
    await seedRestaurant(spec);
  }
  console.log(`[seed] Done. ${RESTAURANTS.length} restaurants seeded.`);
}

main()
  .catch((error: unknown) => {
    console.error('[seed] Failed:', error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
