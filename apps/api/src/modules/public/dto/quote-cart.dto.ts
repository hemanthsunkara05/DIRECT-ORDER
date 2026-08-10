import { z } from 'zod';

/**
 * `POST /public/checkout/quote` (docs/04-api-specification.md §8.3).
 * Deliberately narrower than the endpoint's eventual full documented
 * shape ("cart, address, coupon, loyalty intent") — `restaurantSlug`
 * plus `items` is everything the pricing engine and cart-validation
 * logic actually need today. `couponCode`/`redeemLoyaltyPoints` are
 * left out rather than accepted-and-silently-ignored: there is no
 * Promotion or LoyaltyLedger table yet (Phase 14/16), so a field that
 * can never do anything is worse than an absent one. `address` is
 * omitted for the same reason — the only delivery-fee mode this phase
 * can actually compute (FLAT/FREE) doesn't need it; DISTANCE_BASED
 * falls back to the flat fee until real distance/geo tooling exists
 * (Phase 11+). A persisted, cartId-addressable cart (`POST
 * /public/carts`, BR-31's 24h TTL) is Phase 9's concern, once checkout
 * actually needs a cart reference that survives a payment redirect —
 * this endpoint takes cart contents directly instead.
 */
export const QuoteCartDto = z.object({
  restaurantSlug: z.string().trim().min(1),
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        // BR-23: per-item quantity is capped (default 99) and validated server-side.
        quantity: z.number().int().min(1).max(99),
        // BR-2/BR-20: never trusted as the price — only compared against
        // the live price to detect drift, and only for that purpose.
        unitPriceMinorAtAdd: z.coerce.bigint().positive(),
      }),
    )
    .min(1, 'Cart must contain at least one item.')
    .max(100),
});

export type QuoteCartInput = z.infer<typeof QuoteCartDto>;
