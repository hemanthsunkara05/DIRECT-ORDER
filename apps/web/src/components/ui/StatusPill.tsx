export type StatusTone = 'fresh' | 'warn' | 'error' | 'ink';

export interface StatusPillProps {
  label: string;
  tone: StatusTone;
  className?: string;
}

const TONE_CLASSES: Record<StatusTone, string> = {
  fresh: 'bg-fresh-100 text-fresh-700',
  warn: 'bg-warn-100 text-warn-700',
  error: 'bg-error-100 text-error-700',
  ink: 'bg-ink-100 text-ink-700',
};

/**
 * Counter's one status pill, for every status vocabulary in the app —
 * order status, restaurant status, invitation status, support case
 * status, promotion state. `tone` is always one of exactly four values
 * (readme.md's semantic-color rule: fresh = live progress/success only,
 * warn = pending/needs attention, error = rejected/failed/blocked, ink
 * = neutral/inactive) — never a fifth ad-hoc color, and never the brand
 * accent, which the design system reserves for actions, not state.
 * Pair with a `*_TONE` map below (or a page-local equivalent) rather
 * than passing `tone` from a switch inline at each call site, so the
 * enum-to-tone mapping for a given vocabulary lives in exactly one place.
 */
export function StatusPill({ label, tone, className = '' }: StatusPillProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 font-body text-xs font-semibold ${TONE_CLASSES[tone]} ${className}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Restaurant.status (RestaurantStatus, apps/api/prisma/schema.prisma). */
export const RESTAURANT_STATUS_TONE: Record<string, StatusTone> = {
  DRAFT: 'ink',
  PENDING_APPROVAL: 'warn',
  ACTIVE: 'fresh',
  SUSPENDED: 'error',
  REJECTED: 'error',
  CLOSED: 'ink',
};

/** Order.status (OrderStatus). Everything mid-flow reads as "in progress" (warn) until it resolves fresh (delivered) or error (cancelled/rejected/failed). */
export const ORDER_STATUS_TONE: Record<string, StatusTone> = {
  PENDING_PAYMENT: 'ink',
  PLACED: 'warn',
  ACCEPTED: 'warn',
  PREPARING: 'warn',
  READY_FOR_PICKUP: 'warn',
  OUT_FOR_DELIVERY: 'warn',
  DELIVERED: 'fresh',
  CANCELLED: 'error',
  REJECTED: 'error',
};

/** Staff invitation status. */
export const INVITATION_STATUS_TONE: Record<string, StatusTone> = {
  PENDING: 'warn',
  ACCEPTED: 'fresh',
  EXPIRED: 'error',
  REVOKED: 'error',
};

/** Support case status. */
export const SUPPORT_CASE_STATUS_TONE: Record<string, StatusTone> = {
  OPEN: 'warn',
  IN_PROGRESS: 'warn',
  RESOLVED: 'fresh',
  CLOSED: 'ink',
};

export function statusLabel(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}
