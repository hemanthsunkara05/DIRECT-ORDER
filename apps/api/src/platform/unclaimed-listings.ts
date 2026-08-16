/**
 * The single account that technically "owns" every unclaimed preview
 * listing (outreach-batch restaurants seeded without a real owner) —
 * has no passwordHash, so nothing can ever log into it. A restaurant
 * owned only by this account is, by definition, unclaimed: there is no
 * schema field for it, since "unclaimed" IS "owned by this account and
 * nothing else." Shared between RestaurantService (claim) and the admin
 * outreach list so both agree on exactly the same definition.
 */
export const UNCLAIMED_PLACEHOLDER_EMAIL = 'unclaimed-listings@direct-order.local';
