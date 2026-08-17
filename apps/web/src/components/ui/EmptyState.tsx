import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';

export interface EmptyStateProps {
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  icon?: LucideIcon;
}

/**
 * One shared empty state for every empty queue/list in the app — a
 * short message plus, where there's something the viewer can actually
 * do about it, one action. Genuinely empty ("no active orders") and
 * "still loading" must never share this component (the report flagged
 * conflating the two as a gap); callers render their own loading state
 * and reach for `EmptyState` only once a fetch has resolved to zero rows.
 */
export function EmptyState({ message, actionLabel, onAction, icon: Icon = Inbox }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <Icon className="h-8 w-8 text-ink-400" aria-hidden="true" />
      <p className="max-w-sm text-sm text-ink-500">{message}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="font-body text-sm font-semibold text-brand-600 hover:text-brand-700"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
