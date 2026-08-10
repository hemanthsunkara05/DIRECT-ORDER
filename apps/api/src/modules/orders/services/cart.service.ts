import { randomBytes, createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Env } from '../../../platform/config/env.schema.js';
import { APP_CONFIG } from '../../../platform/config/config.module.js';
import { NotFoundError } from '../../../platform/errors/app-error.js';
import { PublicRestaurantRepository } from '../../public/repositories/public-restaurant.repository.js';
import {
  CheckoutQuoteService,
  type QuoteResult,
} from '../../public/services/checkout-quote.service.js';
import { CartRepository, type CartWithItems } from '../repositories/cart.repository.js';

const HOUR_MS = 3_600_000;

export interface IssuedCart {
  cart: CartWithItems;
  /** The raw guest token — returned once; only its hash is persisted (same pattern as staff invitations/TokenService). */
  guestToken: string;
}

/**
 * `POST /public/carts` / `POST /public/carts/:id/validate`
 * (docs/04-api-specification.md §8.3). Validation delegates entirely to
 * `CheckoutQuoteService.quoteByRestaurantId` — this service's own job is
 * persistence and guest-token ownership, not re-deriving pricing/
 * availability logic a second time.
 */
@Injectable()
export class CartService {
  constructor(
    @Inject(APP_CONFIG) private readonly env: Env,
    @Inject(CartRepository) private readonly carts: CartRepository,
    @Inject(PublicRestaurantRepository) private readonly restaurants: PublicRestaurantRepository,
    @Inject(CheckoutQuoteService) private readonly quoteService: CheckoutQuoteService,
  ) {}

  async create(
    restaurantSlug: string,
    items: { itemId: string; quantity: number; unitPriceMinorAtAdd: bigint }[],
  ): Promise<IssuedCart> {
    const restaurant = await this.restaurants.findBySlug(restaurantSlug);
    if (!restaurant || restaurant.status === 'DRAFT' || restaurant.status === 'PENDING_APPROVAL') {
      throw new NotFoundError('Restaurant not found.');
    }

    const guestToken = randomBytes(32).toString('base64url');
    const cart = await this.carts.create({
      restaurantId: restaurant.id,
      guestTokenHash: hashToken(guestToken),
      expiresAt: new Date(Date.now() + this.env.CART_TTL_HOURS * HOUR_MS),
      items: items.map((item) => ({
        menuItemId: item.itemId,
        quantity: item.quantity,
        unitPriceMinorAtAdd: item.unitPriceMinorAtAdd,
      })),
    });

    return { cart, guestToken };
  }

  async validate(cartId: string, guestToken: string): Promise<QuoteResult> {
    const cart = await this.loadOwnedCart(cartId, guestToken);
    return this.quoteService.quoteByRestaurantId(
      cart.restaurantId,
      cart.items.map((item) => ({
        itemId: item.menuItemId,
        quantity: item.quantity,
        unitPriceMinorAtAdd: item.unitPriceMinorAtAdd,
      })),
    );
  }

  /**
   * Verifies cart ownership via the guest token hash — a mismatch or
   * expired/already-converted cart is reported identically as
   * `NotFoundError` (not a distinct "wrong token" error) so a guess at
   * a valid cart id can't be distinguished from an invalid token by an
   * attacker probing the endpoint.
   */
  async loadOwnedCart(cartId: string, guestToken: string): Promise<CartWithItems> {
    const cart = await this.carts.findByIdWithItems(cartId);
    if (!cart || cart.guestTokenHash !== hashToken(guestToken)) {
      throw new NotFoundError('Cart not found.');
    }
    if (cart.status !== 'OPEN' || cart.expiresAt.getTime() < Date.now()) {
      throw new NotFoundError('Cart not found.');
    }
    return cart;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
