'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, reviewsApi, type OwnReview } from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';

export default function RestaurantReviewsPage() {
  return (
    <ProtectedRoute>
      <ReviewsManager />
    </ProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

/** BR-121: no edit/hide/delete action exists here at all — only reading and, per review, one response. */
function ReviewsManager() {
  const { user } = useSession();
  const restaurantId = user?.restaurantMemberships.find((m) => m.role !== 'STAFF')?.restaurantId;

  const [reviews, setReviews] = useState<OwnReview[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!restaurantId) return;
    try {
      setReviews(await reviewsApi.listOwn(restaurantId));
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!restaurantId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-slate-500">You don&apos;t manage a restaurant.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <h1 className="text-xl font-semibold">Reviews</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <ul className="flex flex-col gap-3">
        {reviews?.map((review) => (
          <ReviewCard key={review.id} review={review} onResponded={load} />
        ))}
      </ul>
      {reviews !== null && reviews.length === 0 && (
        <p className="text-sm text-slate-500">No reviews yet.</p>
      )}
    </main>
  );
}

function ReviewCard({
  review,
  onResponded,
}: {
  review: OwnReview;
  onResponded: () => Promise<void>;
}) {
  const [responding, setResponding] = useState(false);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await reviewsApi.respond(review.id, body.trim());
      setResponding(false);
      setBody('');
      await onResponded();
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="rounded-lg border border-slate-200 p-4 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">{'★'.repeat(review.rating)}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-xs ${
            review.status === 'PUBLISHED'
              ? 'bg-emerald-100 text-emerald-700'
              : 'bg-slate-100 text-slate-500'
          }`}
        >
          {review.status}
        </span>
      </div>
      {review.body && <p className="mt-2 text-slate-700">{review.body}</p>}

      {!responding && (
        <button
          type="button"
          onClick={() => setResponding(true)}
          className="mt-3 text-xs text-indigo-600 underline"
        >
          Respond
        </button>
      )}
      {responding && (
        <form onSubmit={(e) => void handleSubmit(e)} className="mt-3 flex flex-col gap-2">
          <textarea
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            placeholder="Thank the customer or address their feedback…"
            className="input"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className="btn-primary w-fit">
              {saving ? 'Posting…' : 'Post response'}
            </button>
            <button
              type="button"
              onClick={() => setResponding(false)}
              className="btn-secondary w-fit"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
