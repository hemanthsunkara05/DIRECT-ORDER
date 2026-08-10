import type { RestaurantRole } from './permission.catalogue.js';

/**
 * The resolved tenant for the current request — attached to
 * `request.tenant` by AuthorizationGuard, read back by
 * `@CurrentTenant()`. Never trust a restaurantId from anywhere else
 * (path, body, header) once this exists; it is the one place a
 * restaurantId is authoritative for the rest of the request.
 */
export interface TenantContext {
  restaurantId: string;
  staffId: string;
  role: RestaurantRole;
}
