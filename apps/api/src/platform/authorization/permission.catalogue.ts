/**
 * The permission catalogue (docs/05-authorization-matrix.md §9.2) as
 * typed data, not scattered `if (role === ...)` checks. `PermissionsGuard`
 * (authorization.guard.ts) is the only code that reads this at request
 * time; permission.catalogue.test.ts asserts every cell of the
 * documented matrix against it.
 *
 * `Role` includes SUPPORT/ADMIN_OPERATIONS/ADMIN_FINANCE/SUPER_ADMIN even
 * though no principal can actually authenticate as any of them yet — the
 * `admin_users` table and its login path are Phase 13. The catalogue is
 * pure data, so encoding the full documented matrix now costs nothing
 * and means Phase 13 extends this file instead of writing it from
 * scratch. `PermissionsGuard` itself, today, can only ever resolve a
 * restaurant role (STAFF/MANAGER/OWNER) — see its doc comment.
 */

export const RESTAURANT_ROLES = ['STAFF', 'MANAGER', 'OWNER'] as const;
export type RestaurantRole = (typeof RESTAURANT_ROLES)[number];

export const ADMIN_ROLES = ['SUPPORT', 'ADMIN_OPERATIONS', 'ADMIN_FINANCE', 'SUPER_ADMIN'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export type Role = RestaurantRole | AdminRole;

export const PERMISSIONS = [
  'restaurant:read',
  'restaurant:update',
  'restaurant:branding',
  'restaurant:settings',
  'restaurant:hours',
  'restaurant:availability',
  'restaurant:approve',
  'restaurant:suspend',
  'menu:read',
  'menu:write',
  'menu:availability',
  'orders:read',
  'orders:accept',
  'orders:reject',
  'orders:transition',
  'orders:cancel',
  'payments:read',
  'payments:refund',
  'payments:reconcile',
  'delivery:read',
  'delivery:redispatch',
  'staff:read',
  'staff:invite',
  'staff:role_change',
  'staff:disable',
  'promotions:read',
  'promotions:write',
  'promotions:platform',
  'reviews:read',
  'reviews:respond',
  'reviews:moderate',
  'loyalty:read',
  'loyalty:adjust',
  'support:read',
  'support:write',
  'support:internal_notes',
  'support:assign',
  'analytics:restaurant',
  'analytics:platform',
  'users:read',
  'users:disable',
  'admin:role_manage',
  'audit:read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * One row per permission, `true` for every role that holds it — a
 * direct transcription of the docs/05-authorization-matrix.md §9.2
 * table, cell for cell. **Restaurant roles are ordered** (OWNER >
 * MANAGER > STAFF): the table only ever grants a restaurant permission
 * going "up" from STAFF, never skipping a tier, so MANAGER/OWNER always
 * carry everything STAFF does. **Admin roles are not ordered** — each
 * row lists its holders explicitly rather than inheriting, so a
 * SUPPORT/OPS/FINANCE role can never gain another's capability by
 * accident (docs/05 §9.1).
 */
const MATRIX: Record<Permission, readonly Role[]> = {
  'restaurant:read': [
    'STAFF',
    'MANAGER',
    'OWNER',
    'SUPPORT',
    'ADMIN_OPERATIONS',
    'ADMIN_FINANCE',
    'SUPER_ADMIN',
  ],
  'restaurant:update': ['MANAGER', 'OWNER', 'SUPER_ADMIN'],
  'restaurant:branding': ['MANAGER', 'OWNER', 'SUPER_ADMIN'],
  'restaurant:settings': ['MANAGER', 'OWNER', 'SUPER_ADMIN'],
  'restaurant:hours': ['MANAGER', 'OWNER', 'SUPER_ADMIN'],
  'restaurant:availability': ['STAFF', 'MANAGER', 'OWNER', 'SUPER_ADMIN'],
  'restaurant:approve': ['ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'restaurant:suspend': ['ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'menu:read': ['STAFF', 'MANAGER', 'OWNER', 'SUPPORT', 'ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'menu:write': ['MANAGER', 'OWNER', 'SUPER_ADMIN'],
  'menu:availability': ['STAFF', 'MANAGER', 'OWNER', 'SUPER_ADMIN'],
  'orders:read': [
    'STAFF',
    'MANAGER',
    'OWNER',
    'SUPPORT',
    'ADMIN_OPERATIONS',
    'ADMIN_FINANCE',
    'SUPER_ADMIN',
  ],
  'orders:accept': ['STAFF', 'MANAGER', 'OWNER'],
  'orders:reject': ['STAFF', 'MANAGER', 'OWNER'],
  'orders:transition': ['STAFF', 'MANAGER', 'OWNER'],
  'orders:cancel': ['ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'payments:read': [
    'MANAGER',
    'OWNER',
    'SUPPORT',
    'ADMIN_OPERATIONS',
    'ADMIN_FINANCE',
    'SUPER_ADMIN',
  ],
  'payments:refund': ['ADMIN_FINANCE', 'SUPER_ADMIN'],
  'payments:reconcile': ['ADMIN_FINANCE', 'SUPER_ADMIN'],
  'delivery:read': ['STAFF', 'MANAGER', 'OWNER', 'SUPPORT', 'ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'delivery:redispatch': ['ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'staff:read': ['MANAGER', 'OWNER', 'ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'staff:invite': ['OWNER', 'SUPER_ADMIN'],
  'staff:role_change': ['OWNER', 'SUPER_ADMIN'],
  'staff:disable': ['OWNER', 'SUPER_ADMIN'],
  'promotions:read': ['MANAGER', 'OWNER', 'SUPPORT', 'ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'promotions:write': ['MANAGER', 'OWNER', 'SUPER_ADMIN'],
  'promotions:platform': ['ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'reviews:read': ['STAFF', 'MANAGER', 'OWNER', 'SUPPORT', 'ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'reviews:respond': ['MANAGER', 'OWNER', 'SUPER_ADMIN'],
  'reviews:moderate': ['ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'loyalty:read': ['SUPPORT', 'ADMIN_OPERATIONS', 'ADMIN_FINANCE', 'SUPER_ADMIN'],
  'loyalty:adjust': ['SUPER_ADMIN'],
  'support:read': ['MANAGER', 'OWNER', 'SUPPORT', 'ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'support:write': ['MANAGER', 'OWNER', 'SUPPORT', 'ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'support:internal_notes': ['SUPPORT', 'ADMIN_OPERATIONS', 'ADMIN_FINANCE', 'SUPER_ADMIN'],
  'support:assign': ['SUPPORT', 'ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'analytics:restaurant': ['MANAGER', 'OWNER', 'ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'analytics:platform': ['ADMIN_OPERATIONS', 'ADMIN_FINANCE', 'SUPER_ADMIN'],
  'users:read': ['SUPPORT', 'ADMIN_OPERATIONS', 'SUPER_ADMIN'],
  'users:disable': ['SUPER_ADMIN'],
  'admin:role_manage': ['SUPER_ADMIN'],
  'audit:read': ['SUPER_ADMIN'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return MATRIX[permission].includes(role);
}

export function permissionHolders(permission: Permission): readonly Role[] {
  return MATRIX[permission];
}
