import { SetMetadata } from '@nestjs/common';
import type { Permission } from './permission.catalogue.js';

export const PERMISSIONS_KEY = 'permissions';

/**
 * Declares which permission(s) a route requires (docs/05-authorization-matrix.md
 * §9.2). Read by AuthorizationGuard, which resolves the caller's role
 * from their tenant membership and checks it against the catalogue —
 * this decorator only records the requirement, it does not enforce
 * anything by itself.
 */
export function Permissions(...permissions: Permission[]): MethodDecorator {
  return SetMetadata(PERMISSIONS_KEY, permissions);
}
