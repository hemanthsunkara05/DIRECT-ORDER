import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

/**
 * Carries the current request's correlation ID through async call chains
 * without threading it as an explicit parameter through every service
 * method. Populated once per request by CorrelationMiddleware; read by
 * the pino logger's mixin (logger.ts) and by the global exception
 * filter, so every log line and every error response for a given
 * request shares the same requestId
 * (PRODUCT/docs/12-repository-structure.md §19.7).
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export function getCurrentRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}
