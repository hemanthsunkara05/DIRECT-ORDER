import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { requestContextStorage } from './request-context.js';

const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Establishes the correlation ID for every request, either by trusting
 * an inbound `X-Request-Id` (useful when a request already carries one
 * from an upstream proxy) or generating a fresh UUID. The rest of the
 * request — every service call, every log line, the eventual error
 * envelope — runs inside `requestContextStorage.run(...)`, so
 * `getCurrentRequestId()` resolves correctly anywhere in the call chain
 * without the ID being passed explicitly.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(
    req: { headers: Record<string, unknown> },
    res: { setHeader: (name: string, value: string) => void },
    next: () => void,
  ): void {
    const inbound = req.headers[REQUEST_ID_HEADER];
    const requestId = typeof inbound === 'string' && inbound.length > 0 ? inbound : randomUUID();

    res.setHeader(REQUEST_ID_HEADER, requestId);

    requestContextStorage.run({ requestId }, () => {
      next();
    });
  }
}
