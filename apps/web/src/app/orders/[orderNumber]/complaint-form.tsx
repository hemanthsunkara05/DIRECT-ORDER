'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ApiError, guestSupportApi, type SupportCaseSummary } from '@/lib/api-client';

const CATEGORIES: { value: SupportCaseSummary['category']; label: string }[] = [
  { value: 'ORDER', label: 'Wrong or missing item' },
  { value: 'DELIVERY', label: 'Delivery problem' },
  { value: 'PAYMENT', label: 'Payment issue' },
  { value: 'RESTAURANT', label: 'Restaurant issue' },
  { value: 'OTHER', label: 'Something else' },
];

/**
 * `POST /public/orders/:orderNumber/support-cases` — the guest complaint
 * path (spec: "Guest order complaint path"). Same token-as-identity
 * pattern `ReviewForm` already uses; unlike the review form this isn't
 * gated to `DELIVERED` — a guest can report a problem with an order at
 * any point after it's actually placed (see `COMPLAINABLE_STATUSES` on
 * the API side for the exact boundary).
 */
export function ComplaintForm({ orderNumber, token }: { orderNumber: string; token: string }) {
  const [category, setCategory] = useState<SupportCaseSummary['category']>('ORDER');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<SupportCaseSummary | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await guestSupportApi.create(orderNumber, token, {
        category,
        subject: subject.trim(),
        description: description.trim(),
      });
      setCreated(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Could not submit your report.');
    } finally {
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <p className="text-sm text-emerald-800">
          We&apos;ve received your report ({created.caseNumber}).{' '}
          <Link
            href={`/orders/${orderNumber}/support-cases/${created.id}?token=${encodeURIComponent(token)}`}
            className="font-medium underline"
          >
            View it here
          </Link>{' '}
          — you can come back to this same link any time to see replies.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-200 p-4">
      <h2 className="mb-2 text-sm font-semibold">Report a problem with this order</h2>
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value as SupportCaseSummary['category'])}
          className="input"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Short summary"
          required
          maxLength={200}
          className="input"
        />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What happened?"
          required
          rows={4}
          maxLength={5000}
          className="input"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={submitting} className="btn-primary w-fit">
          {submitting ? 'Submitting…' : 'Submit report'}
        </button>
      </form>
    </section>
  );
}
