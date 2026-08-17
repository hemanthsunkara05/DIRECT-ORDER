'use client';

export interface ModalProps {
  title: string;
  /** One sentence of consequence copy under the title — what this action does. */
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Action row, right-aligned (Cancel + primary/destructive confirm) — pass Button elements. */
  footer?: React.ReactNode;
}

/**
 * Counter's one modal shell — verified against the reference mockup's
 * "RESTAURANTS — SUSPEND MODAL" panel (Admin Console.dc.html): a
 * `rgba(22,34,58,.34)` scrim (the same navy-tinted overlay color the
 * readme names for the storefront's cart panel — one scrim recipe for
 * the whole app), a 420px sh-3-elevated card, 24px padding. Domain
 * modals (ReasonModal, confirmation dialogs, …) compose this rather
 * than reimplementing the shell.
 */
export function Modal({ title, description, onClose, children, footer }: ModalProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(22,34,58,.34)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[420px] rounded-card bg-surface p-6 shadow-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="modal-title" className="font-body text-base font-bold text-ink-900">
          {title}
        </h2>
        {description && <p className="mt-1.5 text-[13px] text-ink-500">{description}</p>}
        <div className="mt-3.5">{children}</div>
        {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
