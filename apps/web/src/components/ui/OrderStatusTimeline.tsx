import { Check } from 'lucide-react';

const HAPPY_PATH = [
  { status: 'PLACED', label: 'Placed' },
  { status: 'ACCEPTED', label: 'Accepted' },
  { status: 'PREPARING', label: 'Preparing' },
  { status: 'READY_FOR_PICKUP', label: 'Ready' },
  { status: 'OUT_FOR_DELIVERY', label: 'Out for delivery' },
  { status: 'DELIVERED', label: 'Delivered' },
] as const;

export interface OrderStatusTimelineProps {
  status: string;
}

/**
 * A visual stepped progress bar for the order's happy path — the
 * report-confirmed gap on this page (only a plain status label + a
 * flat status-history list existed before). Deliberately only handles
 * the six PLACED→DELIVERED statuses: exception states (PAYMENT_FAILED,
 * REJECTED, CANCELLED, DELIVERY_FAILED, EXPIRED) already have their own
 * dedicated sections on this page with specific next-step copy, and
 * forcing them onto a linear stepper would blur "what happened" into
 * "how far did it get" — the caller should render this only when
 * `status` is one of the six below.
 */
export function OrderStatusTimeline({ status }: OrderStatusTimelineProps) {
  const currentIndex = HAPPY_PATH.findIndex((step) => step.status === status);
  if (currentIndex === -1) return null;

  return (
    <ol className="flex items-start">
      {HAPPY_PATH.map((step, index) => {
        const done = index < currentIndex;
        const current = index === currentIndex;
        const reached = done || current;
        return (
          <li key={step.status} className="flex flex-1 flex-col items-center last:flex-none">
            <div className="flex w-full items-center">
              <div
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2 ${
                  reached ? 'border-fresh-500 bg-fresh-500 text-white' : 'border-ink-300 bg-surface'
                }`}
              >
                {done ? (
                  <Check className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  current && <span className="h-2 w-2 rounded-full bg-white" aria-hidden="true" />
                )}
              </div>
              {index < HAPPY_PATH.length - 1 && (
                <div className={`h-0.5 flex-1 ${done ? 'bg-fresh-500' : 'bg-ink-200'}`} aria-hidden="true" />
              )}
            </div>
            <span
              className={`mt-1.5 text-center text-[11px] font-semibold ${
                reached ? 'text-ink-900' : 'text-ink-400'
              }`}
            >
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
