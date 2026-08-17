import { describe, expect, it } from 'vitest';
import {
  hasPermission,
  PERMISSIONS,
  RESTAURANT_ROLES,
  ADMIN_ROLES,
  type Role,
} from '../src/platform/authorization/permission.catalogue.js';

/**
 * Transcribed directly from docs/05-authorization-matrix.md §9.2 — kept
 * as literal table text (not a second hand-derived role list) so this
 * test parses the same shape the doc presents, rather than risking the
 * same transcription mistake twice by re-deriving arrays from memory.
 * Column order: STAFF | MANAGER | OWNER | SUPPORT | OPS | FINANCE | SUPER
 */
const DOC_MATRIX = `
restaurant:read         | x | x | x | x | x | x | x
restaurant:update       |   | x | x |   |   |   | x
restaurant:branding     |   | x | x |   |   |   | x
restaurant:settings     |   | x | x |   |   |   | x
restaurant:hours        |   | x | x |   |   |   | x
restaurant:availability | x | x | x |   |   |   | x
restaurant:approve      |   |   |   |   | x |   | x
restaurant:reject       |   |   |   |   | x |   | x
restaurant:suspend      |   |   |   |   | x |   | x
menu:read               | x | x | x | x | x |   | x
menu:write              |   | x | x |   |   |   | x
menu:availability       | x | x | x |   |   |   | x
orders:read             | x | x | x | x | x | x | x
orders:accept           | x | x | x |   |   |   |
orders:reject           | x | x | x |   |   |   |
orders:transition       | x | x | x |   |   |   |
orders:cancel           |   |   |   |   | x |   | x
payments:read           |   | x | x | x | x | x | x
payments:refund         |   |   |   |   |   | x | x
payments:reconcile      |   |   |   |   |   | x | x
delivery:read           | x | x | x | x | x |   | x
delivery:redispatch     |   |   |   |   | x |   | x
staff:read              |   | x | x |   | x |   | x
staff:invite            |   |   | x |   |   |   | x
staff:role_change       |   |   | x |   |   |   | x
staff:disable           |   |   | x |   |   |   | x
promotions:read         |   | x | x | x | x |   | x
promotions:write        |   | x | x |   |   |   | x
promotions:platform     |   |   |   |   | x |   | x
reviews:read            | x | x | x | x | x |   | x
reviews:respond         |   | x | x |   |   |   | x
reviews:moderate        |   |   |   |   | x |   | x
loyalty:read            |   |   |   | x | x | x | x
loyalty:adjust          |   |   |   |   |   |   | x
support:read            |   | x | x | x | x |   | x
support:write           |   | x | x | x | x |   | x
support:internal_notes  |   |   |   | x | x | x | x
support:assign          |   |   |   | x | x |   | x
analytics:restaurant    |   | x | x |   | x |   | x
analytics:platform      |   |   |   |   | x | x | x
users:read              |   |   |   | x | x |   | x
users:disable           |   |   |   |   |   |   | x
admin:role_manage       |   |   |   |   |   |   | x
audit:read              |   |   |   |   |   |   | x
`;

const COLUMN_ROLES: Role[] = [
  'STAFF',
  'MANAGER',
  'OWNER',
  'SUPPORT',
  'ADMIN_OPERATIONS',
  'ADMIN_FINANCE',
  'SUPER_ADMIN',
];

function parseDocMatrix(): Map<string, Set<Role>> {
  const result = new Map<string, Set<Role>>();
  for (const line of DOC_MATRIX.trim().split('\n')) {
    const [permissionPart, ...cells] = line.split('|').map((s) => s.trim());
    const permission = permissionPart!;
    const holders = new Set<Role>();
    cells.forEach((cell, i) => {
      if (cell === 'x') holders.add(COLUMN_ROLES[i]!);
    });
    result.set(permission, holders);
  }
  return result;
}

describe('permission catalogue (docs/05-authorization-matrix.md §9.2)', () => {
  const expected = parseDocMatrix();
  const allRoles = [...RESTAURANT_ROLES, ...ADMIN_ROLES];

  it('the doc fixture above covers every permission the catalogue exports', () => {
    expect(new Set(expected.keys())).toEqual(new Set(PERMISSIONS));
  });

  it.each(PERMISSIONS)('%s matches the documented matrix for every role', (permission) => {
    const holders = expected.get(permission)!;
    for (const role of allRoles) {
      expect(hasPermission(role, permission)).toBe(holders.has(role));
    }
  });

  it('restaurant roles are ordered — MANAGER and OWNER hold everything STAFF holds (docs §9.1)', () => {
    for (const permission of PERMISSIONS) {
      if (hasPermission('STAFF', permission)) {
        expect(hasPermission('MANAGER', permission)).toBe(true);
        expect(hasPermission('OWNER', permission)).toBe(true);
      }
      if (hasPermission('MANAGER', permission)) {
        expect(hasPermission('OWNER', permission)).toBe(true);
      }
    }
  });

  it('SUPER_ADMIN holds almost every permission — except the restaurant-operational order actions, which the documented table deliberately leaves to restaurant roles only', () => {
    const ORDER_OPERATIONS_EXCLUDED_FROM_SUPER = [
      'orders:accept',
      'orders:reject',
      'orders:transition',
    ];
    for (const permission of PERMISSIONS) {
      const expectedHolder = !ORDER_OPERATIONS_EXCLUDED_FROM_SUPER.includes(permission);
      expect(hasPermission('SUPER_ADMIN', permission)).toBe(expectedHolder);
    }
  });

  it('admin roles are NOT ordered — SUPPORT does not inherit FINANCE/OPS capabilities', () => {
    expect(hasPermission('SUPPORT', 'payments:refund')).toBe(false);
    expect(hasPermission('SUPPORT', 'loyalty:adjust')).toBe(false);
    expect(hasPermission('SUPPORT', 'restaurant:approve')).toBe(false);
  });
});
