import { Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ok } from '../../../platform/http/response-envelope.js';
import { ValidationError } from '../../../platform/errors/app-error.js';
import { SkipCsrf } from '../../../platform/security/skip-csrf.decorator.js';
import { WebhookService } from '../services/webhook.service.js';

type RequestWithRawBody = FastifyRequest & { rawBody?: Buffer };

/**
 * `POST /webhooks/razorpay` — signature-authenticated, not
 * cookie/session-authenticated (docs/09-security.md §15.7: "Webhook
 * endpoints are exempt [from CSRF] — no cookies, signature-
 * authenticated"), hence `@SkipCsrf()`.
 *
 * Relies on `rawBody: true` (main.ts's `NestFactory.create` options),
 * which makes `@nestjs/platform-fastify` populate `request.rawBody`
 * with the exact, unparsed request body Buffer — HMAC verification
 * must run over those exact bytes (BR-38), not a re-serialization of
 * the parsed JSON, which is not guaranteed to be byte-identical
 * (key order, whitespace, number formatting can all differ).
 */
@Controller('webhooks/razorpay')
export class WebhookController {
  constructor(@Inject(WebhookService) private readonly webhooks: WebhookService) {}

  @Post()
  @HttpCode(200)
  @SkipCsrf()
  async receive(@Req() request: RequestWithRawBody) {
    if (!request.rawBody) {
      throw new ValidationError('Request body could not be read.');
    }
    const signature = request.headers['x-razorpay-signature'];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;

    await this.webhooks.handle(request.rawBody, signatureHeader);
    return ok({ received: true });
  }
}
