/**
 * Deletes everything scripts/dup-load-test.ts created: every
 * restaurant with a slug starting `loadtest-duplicate-` and its full
 * dependency graph (orders, order items, menu, staff, etc.), plus the
 * owner users it created (email starting `loadtest-owner-`).
 *
 * Run: pnpm tsx --env-file=.env scripts/dup-load-test-cleanup.ts
 *
 * Safe to re-run — no-ops if nothing matches. Does not touch the two
 * real seeded demo restaurants (spice-route / copper-kettle) or the
 * super admin account; only the `loadtest-*` rows this test created.
 */
import { PrismaClient } from '@prisma/client';

const appDatabaseUrl = process.env.APP_DATABASE_URL;
if (!appDatabaseUrl) {
  console.error('[cleanup] APP_DATABASE_URL is required. Copy .env.example to .env first.');
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: appDatabaseUrl } } });

async function main(): Promise<void> {
  const restaurants = await prisma.restaurant.findMany({
    where: { slug: { startsWith: 'loadtest-duplicate-' } },
    select: { id: true, slug: true },
  });

  if (restaurants.length === 0) {
    console.log('[cleanup] No loadtest-duplicate-* restaurants found. Nothing to do.');
  } else {
    const ids = restaurants.map((r) => r.id);
    console.log(`[cleanup] Found ${restaurants.length} load-test restaurants: ${restaurants.map((r) => r.slug).join(', ')}`);

    // Delete in dependency order — Order/OrderItem/Delivery/etc. use
    // onDelete: Restrict against their parent, so children must go
    // first. `Delivery` only exists for orders the lifecycle script drove
    // through READY_FOR_PICKUP or further (dup-load-test.ts's `ready`
    // call auto-creates one via DeliveryDispatchService) — absent from
    // earlier runs that only ever placed orders, present now that it
    // drives the full lifecycle, which is exactly what surfaced this gap.
    const orders = await prisma.order.findMany({ where: { restaurantId: { in: ids } }, select: { id: true } });
    const orderIds = orders.map((o) => o.id);

    // `Refund.payment` is also `onDelete: Restrict` — cancel() on an
    // already-CAPTURED order auto-refunds it (same real business rule
    // the "admin cancel of a paid order triggers exactly one refund"
    // e2e test covers), so the CANCELLED lifecycle target now leaves a
    // Refund row behind that must go before its Payment can be deleted.
    const payments = await prisma.payment.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } });
    const paymentIds = payments.map((p) => p.id);

    console.log(`[cleanup] Deleting ${orderIds.length} orders and their dependents...`);
    await prisma.$transaction([
      prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } }),
      prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }),
      prisma.refund.deleteMany({ where: { paymentId: { in: paymentIds } } }),
      prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } }),
      prisma.delivery.deleteMany({ where: { orderId: { in: orderIds } } }),
      prisma.order.deleteMany({ where: { id: { in: orderIds } } }),
    ]);

    // `CartItem.menuItemId` is also `onDelete: Restrict` — a cart built
    // during checkout (POST /public/carts) still references these menu
    // items even after the cart converts to an order, so menu items
    // can't be deleted until every cart for these restaurants is gone
    // first. `Cart.restaurant` cascades, but that only helps if the
    // RESTAURANT is deleted directly — this script deletes menu items
    // BEFORE the restaurant, so it needs its own explicit delete here.
    console.log('[cleanup] Deleting carts (and their cart items) for these restaurants...');
    await prisma.cart.deleteMany({ where: { restaurantId: { in: ids } } });

    console.log('[cleanup] Deleting menu items, categories, hours, staff, addresses...');
    await prisma.$transaction([
      prisma.menuItem.deleteMany({ where: { restaurantId: { in: ids } } }),
      prisma.menuCategory.deleteMany({ where: { restaurantId: { in: ids } } }),
      prisma.operatingHours.deleteMany({ where: { restaurantId: { in: ids } } }),
      prisma.restaurantStaff.deleteMany({ where: { restaurantId: { in: ids } } }),
    ]);

    console.log('[cleanup] Deleting restaurants (address/branding/settings cascade)...');
    await prisma.restaurant.deleteMany({ where: { id: { in: ids } } });
  }

  const owners = await prisma.user.findMany({
    where: { email: { startsWith: 'loadtest-owner-' } },
    select: { id: true },
  });
  if (owners.length > 0) {
    console.log(`[cleanup] Deleting ${owners.length} load-test owner users...`);
    await prisma.user.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
  }

  // Guest customers created by the load test all share this phone
  // number (see dup-load-test.ts's placeDuplicateOrder) — safe to
  // remove only if no orders reference it any more (they were just
  // deleted above).
  const leftoverOrdersForPhone = await prisma.order.count({ where: { customerPhone: '+919999999999' } });
  if (leftoverOrdersForPhone === 0) {
    const removed = await prisma.customer.deleteMany({ where: { phone: '+919999999999' } });
    if (removed.count > 0) console.log(`[cleanup] Deleted ${removed.count} load-test guest customer row(s).`);
  }

  console.log('[cleanup] Done.');
}

main()
  .catch((error) => {
    console.error('[cleanup] fatal:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
