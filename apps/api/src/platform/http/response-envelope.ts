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

export interface Pagination {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

/**
 * The cursor-paginated variant (docs/04-api-specification.md §8.1:
 * `meta.pagination: { nextCursor, hasMore, limit }`) — first real use
 * is Phase 10's order queue. `nextCursor` is the last returned item's
 * own id (UUIDv7, time-ordered), the same cursor convention
 * AuditService's pagination already established; callers fetch
 * `limit + 1` rows and pass the extra one's presence as `hasMore`
 * (never the row itself) so the response never leaks it.
 */
export function okPage<T>(
  data: T[],
  pagination: Pagination,
): { data: T[]; meta: { requestId: string; pagination: Pagination } } {
  return {
    data,
    meta: { requestId: getCurrentRequestId() ?? 'unknown', pagination },
  };
}
