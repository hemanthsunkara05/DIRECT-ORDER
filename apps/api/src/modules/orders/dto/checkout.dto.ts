import { z } from 'zod';

/**
 * `POST /public/checkout` (docs/04-api-specification.md §8.3).
 * `couponCode`/`redeemLoyaltyPoints` are omitted for the same reason
 * `QuoteCartDto` omits them — no Promotion/Loyalty tables yet
 * (steps 6-7 of the mandated sequence are deferred, documented in
 * CheckoutService). `deliveryAddress` is stored verbatim as an
 * `Order.deliveryAddress` Json snapshot — structurally validated here,
 * not geocoded/verified (DELIVERY_AREA_UNSUPPORTED needs real
 * geo/distance tooling, Phase 11+, same as DISTANCE_BASED delivery fee).
 */
export const CheckoutDto = z.object({
  cartId: z.string().uuid(),
  guestToken: z.string().min(1),
  customer: z.object({
    name: z.string().trim().min(1).max(200),
    phone: z.string().trim().min(6).max(20),
    email: z.string().trim().email().optional(),
  }),
  deliveryAddress: z.object({
    line1: z.string().trim().min(1).max(300),
    locality: z.string().trim().max(200).optional(),
    city: z.string().trim().min(1).max(120),
    postalCode: z.string().trim().min(3).max(20),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  }),
  // BR-2/BR-20: never authoritative — comparison-only, see step 9.
  expectedTotalMinor: z.coerce.bigint().positive().optional(),
});

export type CheckoutInput = z.infer<typeof CheckoutDto>;
