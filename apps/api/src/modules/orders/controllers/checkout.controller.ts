import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { ok } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { CheckoutDto } from '../dto/checkout.dto.js';
import { CheckoutService } from '../services/checkout.service.js';

/**
 * `POST /public/checkout` (docs/04-api-specification.md §8.3: "Create
 * order + payment intent" — "Idempotency-Key required"). A separate
 * controller class from `PublicCheckoutController` (which owns
 * `POST /public/checkout/quote`) even though they share the
 * `public/checkout` prefix — this one depends on CheckoutService
 * (OrdersModule), and OrdersModule already depends on PublicModule for
 * CheckoutQuoteService/PublicMenuRepository; importing PublicModule
 * back into OrdersModule to merge these into one controller would
 * create a module cycle for no real benefit. Nest routes by exact
 * method+path, so two controllers sharing a prefix is unremarkable.
 */
@Controller('public/checkout')
export class CheckoutController {
  constructor(@Inject(CheckoutService) private readonly checkout: CheckoutService) {}

  @Post()
  @HttpCode(200)
  async create(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey?: string) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new ValidationError('The Idempotency-Key header is required.');
    }
    const input = CheckoutDto.parse(body);
    const result = await this.checkout.checkout(input, idempotencyKey.trim());
    return ok(result);
  }
}
