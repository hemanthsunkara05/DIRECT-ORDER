import { z } from 'zod';

const DELIVERY_FEE_MODES = ['FLAT', 'DISTANCE_BASED', 'FREE'] as const;

/**
 * Money fields are already integer minor units (paise) at rest
 * (`*Minor`, `bigint` — INV-1) — `z.coerce.bigint()` rejects any
 * non-integer input (`BigInt(1.5)` throws), so a fractional value is a
 * validation error here, not a silently-truncated one.
 */
export const UpsertSettingsDto = z.object({
  minOrderAmountMinor: z.coerce.bigint().nonnegative().optional(),
  packagingFeeMinor: z.coerce.bigint().nonnegative().optional(),
  deliveryFeeMode: z.enum(DELIVERY_FEE_MODES).optional(),
  deliveryFeeFlatMinor: z.coerce.bigint().nonnegative().optional(),
  acceptsOnlinePayment: z.boolean().optional(),
  autoAcceptOrders: z.boolean().optional(),
  notificationEmails: z.array(z.string().trim().toLowerCase().email()).max(10).optional(),
  notificationPhones: z.array(z.string().trim().min(1).max(20)).max(10).optional(),
});

export type UpsertSettingsInput = z.infer<typeof UpsertSettingsDto>;
