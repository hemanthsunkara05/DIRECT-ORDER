import { Body, Controller, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { ok } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { serializeBreakdown } from '../serialize-breakdown.js';
import { CreateCartDto } from '../dto/create-cart.dto.js';
import { CartService } from '../services/cart.service.js';

/**
 * `/public/carts/*` (docs/04-api-specification.md §8.3) — unauthenticated,
 * same as every other `/public/*` route. CSRF still applies (no
 * `@SkipCsrf()`) — the frontend already has the double-submit cookie
 * from its first GET, same as `/public/checkout/quote`.
 */
@Controller('public/carts')
export class CartController {
  constructor(@Inject(CartService) private readonly carts: CartService) {}

  @Post()
  @HttpCode(201)
  async create(@Body() body: unknown) {
    const input = CreateCartDto.parse(body);
    const { cart, guestToken } = await this.carts.create(input.restaurantSlug, input.items);
    return ok({
      cartId: cart.id,
      guestToken,
      expiresAt: cart.expiresAt.toISOString(),
    });
  }

  @Post(':id/validate')
  @HttpCode(200)
  async validate(@Param('id') id: string, @Body() body: unknown) {
    const guestToken = extractGuestToken(body);
    const result = await this.carts.validate(id, guestToken);
    return ok({
      valid: result.valid,
      issues: result.issues,
      breakdown: serializeBreakdown(result.breakdown),
    });
  }
}

function extractGuestToken(body: unknown): string {
  const guestToken =
    typeof body === 'object' && body !== null
      ? (body as { guestToken?: unknown }).guestToken
      : undefined;
  if (typeof guestToken === 'string' && guestToken.length > 0) {
    return guestToken;
  }
  throw new ValidationError('guestToken is required.');
}
