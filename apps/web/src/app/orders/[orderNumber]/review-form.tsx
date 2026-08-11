'use client';

import { useState } from 'react';
import { ApiError, orderApi } from '@/lib/api-client';

/**
 * `POST /public/orders/:orderNumber/review` (Phase 15) — the guest
 * access token this page already has (from the URL's `?token=`) is
 * this codebase's only real customer identity (AMB-2), so it doubles
 * as review-submission proof of ownership. A 409 on submit (already
 * reviewed, most likely from a page reload after a prior successful
 * submit) is treated the same as success — there is nothing wrong to
 * show the customer in that case, they already reviewed this order.
 */
export function ReviewForm({ orderNumber, token }: { orderNumber: string; token: string }) {
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await orderApi.submitReview(orderNumber, token, rating, body.trim() || undefined);
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'CONFLICT') {
        setSubmitted(true);
      } else {
        setError(err instanceof ApiError ? err.body.message : 'Could not submit your review.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
        <p className="text-sm text-emerald-800">Thanks for your review!</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-slate-200 p-4">
      <h2 className="mb-2 text-sm font-semibold">Rate this order</h2>
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3">
        <div className="flex gap-1" role="radiogroup" aria-label="Rating">
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              aria-label={`${value} star${value === 1 ? '' : 's'}`}
              onClick={() => setRating(value)}
              className={`text-2xl leading-none ${value <= rating ? 'text-amber-500' : 'text-slate-300'}`}
            >
              ★
            </button>
          ))}
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Tell others about your experience (optional)"
          rows={3}
          maxLength={2000}
          className="input"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={submitting} className="btn-primary w-fit">
          {submitting ? 'Submitting…' : 'Submit review'}
        </button>
      </form>
    </section>
  );
}
