'use client';

import { useState } from 'react';
import { Modal } from './Modal';
import { Button } from './Button';

/**
 * Phase 21a: the canonical design reference (`Admin console build
 * verification package/Admin Console.dc.html`, "RESTAURANTS — SUSPEND
 * MODAL") names a titled modal + textarea + colored confirm button as
 * the established reason-collection pattern — not `window.prompt`.
 * Originally built for admin's Reject/Suspend actions, now shared with
 * the restaurant order queue's Reject action too (same gap, same fix) —
 * lives in `ui/`, not `admin/`, since it's cross-surface.
 */
export function ReasonModal({
  title,
  consequence,
  confirmLabel,
  confirmTone = 'error',
  onConfirm,
  onCancel,
}: {
  title: string;
  consequence: string;
  confirmLabel: string;
  confirmTone?: 'error' | 'primary';
  onConfirm: (reason: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmed = reason.trim();

  async function handleConfirm() {
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(trimmed);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      title={title}
      description={consequence}
      onClose={onCancel}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button
            type="button"
            variant={confirmTone === 'error' ? 'destructive' : 'primary'}
            onClick={() => void handleConfirm()}
            disabled={!trimmed}
            loading={submitting}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <textarea
        autoFocus
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={4}
        maxLength={500}
        placeholder="Reason…"
        className="input w-full"
      />
    </Modal>
  );
}
