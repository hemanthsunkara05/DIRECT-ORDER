/**
 * Compile-time-only assertion, checked by `tsc` (the `typecheck`
 * script), never executed at runtime — same pattern as
 * packages/money/test/money.type-test.ts.
 *
 * Phase 2 acceptance criterion: "A tenant-scoped repository call without
 * a restaurantId fails to compile." This file fails the TypeScript
 * build if that ever stops being true, because an unused
 * `@ts-expect-error` directive is itself a compile error.
 */
import type { RestaurantStaffRepository } from '../src/modules/restaurants/repositories/restaurant-staff.repository.js';

declare const repository: RestaurantStaffRepository;

// @ts-expect-error — findById requires restaurantId as its first argument.
void repository.findById('staff-id-only');

// @ts-expect-error — findActiveOwners requires a restaurantId argument.
void repository.findActiveOwners();

// @ts-expect-error — create requires restaurantId before the input object.
void repository.create({ userId: 'u1', role: 'STAFF' });

// This is the correct call shape — included so the file also proves the
// valid form still compiles, not only that the invalid ones fail.
void repository.findById('restaurant-id', 'staff-id');
