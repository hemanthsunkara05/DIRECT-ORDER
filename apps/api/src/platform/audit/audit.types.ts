/**
 * Who performed an audited action. Kept as a plain union rather than a
 * Prisma enum because `audit_logs.actor_type` is intentionally a free
 * TEXT column (PRODUCT/docs/02-database-schema.md) — the type safety
 * belongs at the application boundary, not the database.
 */
export type AuditActorType = 'CUSTOMER' | 'RESTAURANT_USER' | 'ADMIN' | 'SYSTEM';

/**
 * Input to AuditService.record(). `correlationId` is deliberately absent
 * here — the service fills it in automatically from the current request
 * context, so a caller can never forget it (see audit.service.ts).
 */
export interface AuditEntryInput {
  actorType: AuditActorType;
  actorId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  /** Present whenever the audited entity belongs to a restaurant tenant. */
  restaurantId?: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  ipHash?: string;
}
