import { Controller, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ok } from '../../../platform/http/response-envelope.js';
import { NotFoundError, ValidationError } from '../../../platform/errors/app-error.js';
import { SkipCsrf } from '../../../platform/security/skip-csrf.decorator.js';
import { DELIVERY_PROVIDER, type DeliveryProvider } from '../providers/delivery-provider.port.js';
import { DeliveryWebhookService } from '../services/delivery-webhook.service.js';

type RequestWithRawBody = FastifyRequest & { rawBody?: Buffer };

/**
 * `POST /webhooks/delivery/:provider` (docs/04-api-specification.md
 * §8.6) — signature-authenticated, not session-authenticated, hence
 * `@SkipCsrf()` (same reasoning as `WebhookController`, Phase 9).
 *
 * `:provider` in the path must match the currently-configured
 * `DELIVERY_PROVIDER` — a request for a provider that isn't the active
 * one 404s, the same "indistinguishable from not existing" treatment
 * `OrderTrackingController.simulatePayment` already applies when
 * `PAYMENT_PROVIDER` doesn't match.
 */
@Controller('webhooks/delivery')
export class DeliveryWebhookController {
  constructor(
    @Inject(DeliveryWebhookService) private readonly webhooks: DeliveryWebhookService,
    @Inject(DELIVERY_PROVIDER) private readonly provider: DeliveryProvider,
  ) {}

  @Post(':provider')
  @HttpCode(200)
  @SkipCsrf()
  async receive(@Param('provider') providerParam: string, @Req() request: RequestWithRawBody) {
    if (providerParam !== this.provider.name) {
      throw new NotFoundError();
    }
    if (!request.rawBody) {
      throw new ValidationError('Request body could not be read.');
    }
    const signature = request.headers['x-delivery-signature'];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;

    await this.webhooks.handle(request.rawBody, signatureHeader);
    return ok({ received: true });
  }
}
