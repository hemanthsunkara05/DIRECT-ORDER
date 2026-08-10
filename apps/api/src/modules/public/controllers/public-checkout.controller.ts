import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ok } from '../../../platform/http/response-envelope.js';
import { QuoteCartDto } from '../dto/quote-cart.dto.js';
import { CheckoutQuoteService } from '../services/checkout-quote.service.js';

/**
 * `/public/checkout/*` — unauthenticated, same as `/public/restaurants/*`
 * (docs/04-api-specification.md §8.3). CSRF still applies here (the
 * globally-registered `CsrfGuard` checks every non-GET request
 * regardless of auth state) — this endpoint has no `@SkipCsrf()`, so
 * the frontend attaches `X-CSRF-Token` from the cookie the very first
 * GET to the site already set, same as every other mutating call.
 */
@Controller('public/checkout')
export class PublicCheckoutController {
  constructor(@Inject(CheckoutQuoteService) private readonly quoteService: CheckoutQuoteService) {}

  @Post('quote')
  @HttpCode(200)
  async quote(@Body() body: unknown) {
    const input = QuoteCartDto.parse(body);
    const result = await this.quoteService.quote(input);
    return ok(toPublicQuote(result));
  }
}

function toPublicQuote(result: Awaited<ReturnType<CheckoutQuoteService['quote']>>) {
  const { breakdown } = result;
  return {
    valid: result.valid,
    issues: result.issues,
    breakdown: {
      items: breakdown.items.map((item) => ({
        itemId: item.itemId,
        name: item.name,
        unitPriceMinor: item.unitPriceMinor.toString(),
        quantity: item.quantity,
        lineTotalMinor: item.lineTotalMinor.toString(),
      })),
      itemsSubtotalMinor: breakdown.itemsSubtotalMinor.toString(),
      packagingFeeMinor: breakdown.packagingFeeMinor.toString(),
      deliveryFeeMinor: breakdown.deliveryFeeMinor.toString(),
      platformFeeMinor: breakdown.platformFeeMinor.toString(),
      taxMinor: breakdown.taxMinor.toString(),
      discountableBaseMinor: breakdown.discountableBaseMinor.toString(),
      promotionDiscountMinor: breakdown.promotionDiscountMinor.toString(),
      loyaltyDiscountMinor: breakdown.loyaltyDiscountMinor.toString(),
      discountMinor: breakdown.discountMinor.toString(),
      payableTotalMinor: breakdown.payableTotalMinor.toString(),
    },
  };
}
