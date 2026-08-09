import { uuidv7 } from 'uuidv7';

/**
 * The one place UUIDv7 identifiers are generated in application code
 * (Phase 2 deliverable, PRODUCT/docs/13-implementation-phases.md).
 * UUIDv7 embeds a millisecond timestamp in its high bits, so IDs sort
 * roughly chronologically — better index locality than UUIDv4 for
 * primary keys on high-insert tables like orders and audit_logs
 * (PRODUCT/docs/02-database-schema.md §6.1).
 *
 * Every model's primary key also has `@default(uuid(7))` in
 * schema.prisma, which covers the common case of a plain
 * `prisma.model.create(...)` call — Prisma generates the ID
 * client-side using the same algorithm. Call `generateId()` explicitly
 * only when an ID is needed *before* the insert happens: constructing
 * an object graph across multiple related inserts in one transaction,
 * or referencing an ID in a value (e.g. an idempotency key) ahead of
 * persistence.
 */
export function generateId(): string {
  return uuidv7();
}
