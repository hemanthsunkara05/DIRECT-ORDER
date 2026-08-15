import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { ok } from '../../../platform/http/response-envelope.js';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator.js';
import { serializeBreakdown } from '../../orders/serialize-breakdown.js';
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
  @RateLimit({ limit: 60, windowSeconds: 3600 })
  @HttpCode(200)
  async quote(@Body() body: unknown) {
    const input = QuoteCartDto.parse(body);
    const result = await this.quoteService.quote(input);
    return ok(toPublicQuote(result));
  }
}

function toPublicQuote(result: Awaited<ReturnType<CheckoutQuoteService['quote']>>) {
  return {
    valid: result.valid,
    issues: result.issues,
    breakdown: serializeBreakdown(result.breakdown),
  };
}
