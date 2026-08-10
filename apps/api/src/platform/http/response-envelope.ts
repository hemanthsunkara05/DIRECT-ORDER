import { getCurrentRequestId } from '../logging/request-context.js';

/**
 * Builds the `{ data, meta }` success envelope every `/api/v1/...`
 * response uses (docs/04-api-specification.md §8.1). Centralised here
 * rather than each controller building `{ data, meta: { requestId } }`
 * by hand, so every domain module's controllers agree on the shape by
 * construction.
 */
export function ok<T>(data: T): { data: T; meta: { requestId: string } } {
  return { data, meta: { requestId: getCurrentRequestId() ?? 'unknown' } };
}
