import { Body, Controller, Headers, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ok } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { OptionalAuthService } from '../../identity/services/optional-auth.service.js';
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
 *
 * No `@UseGuards(AuthGuard)` here (Phase 16) — this endpoint must keep
 * working for a guest with no session at all, AMB-2's "never blocked"
 * requirement. `OptionalAuthService.resolve` performs the same live
 * user/session checks `AuthGuard` does, just returning `null` instead
 * of throwing when there is no session, an invalid one, or a revoked
 * one — `CheckoutService` only ever sees a resolved `userId` or
 * `null`, never a raw cookie.
 */
@Controller('public/checkout')
export class CheckoutController {
  constructor(
    @Inject(CheckoutService) private readonly checkout: CheckoutService,
    @Inject(OptionalAuthService) private readonly optionalAuth: OptionalAuthService,
  ) {}

  @Post()
  @HttpCode(200)
  async create(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new ValidationError('The Idempotency-Key header is required.');
    }
    const input = CheckoutDto.parse(body);
    const identity = await this.optionalAuth.resolve(request);
    const result = await this.checkout.checkout(
      input,
      idempotencyKey.trim(),
      identity ? { userId: identity.user.id } : null,
    );
    return ok(result);
  }
}
