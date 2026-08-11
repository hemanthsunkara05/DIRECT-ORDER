import type { AdminRole } from './permission.catalogue.js';

/** The resolved admin principal for the current request — attached to `request.admin` by AuthorizationGuard, read back by `@CurrentAdmin()`. */
export interface AdminContext {
  adminUserId: string;
  role: AdminRole;
}
