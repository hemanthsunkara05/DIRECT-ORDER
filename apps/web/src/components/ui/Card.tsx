export type CardElevation = 1 | 2 | 3;

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** sh-1 (resting card, the default), sh-2 (lifted chrome — headers), sh-3 (overlays — modals, cart panel). */
  elevation?: CardElevation;
}

const SHADOW_CLASSES: Record<CardElevation, string> = {
  1: 'shadow-1',
  2: 'shadow-2',
  3: 'shadow-3',
};

/**
 * Counter's one card surface: white, 1px ink-200 border, 12px radius,
 * navy-tinted shadow. Deliberately no colored left-border accent
 * variant — the readme is explicit that this system never uses one;
 * status belongs on a `StatusPill` inside the card, not the card's edge.
 */
export function Card({ elevation = 1, className = '', children, ...props }: CardProps) {
  return (
    <div
      className={`rounded-card border border-ink-200 bg-surface p-[22px] ${SHADOW_CLASSES[elevation]} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
