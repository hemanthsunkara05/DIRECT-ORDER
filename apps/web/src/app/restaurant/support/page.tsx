'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, supportApi, type SupportCaseSummary } from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';

export default function RestaurantSupportPage() {
  return (
    <ProtectedRoute>
      <SupportCasesView />
    </ProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

const CATEGORIES: SupportCaseSummary['category'][] = ['ORDER', 'PAYMENT', 'DELIVERY', 'ACCOUNT', 'RESTAURANT', 'OTHER'];

function SupportCasesView() {
  const { user } = useSession();
  const restaurantId = user?.restaurantMemberships.find((m) => m.role !== 'STAFF')?.restaurantId;

  const [cases, setCases] = useState<SupportCaseSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    if (!restaurantId) return;
    try {
      const page = await supportApi.listRestaurant({}, restaurantId);
      setCases(page.items);
      setError(null);
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
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Support</h1>
        <button type="button" onClick={() => setShowForm((v) => !v)} className="btn-secondary">
          {showForm ? 'Cancel' : 'New case'}
        </button>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {showForm && (
        <NewCaseForm
          restaurantId={restaurantId}
          onCreated={async () => {
            setShowForm(false);
            await load();
          }}
        />
      )}

      {cases === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : cases.length === 0 ? (
        <p className="text-sm text-slate-500">No support cases yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-slate-200 rounded-lg border border-slate-200">
          {cases.map((c) => (
            <li key={c.id}>
              <Link href={`/restaurant/support/${c.id}`} className="flex flex-col gap-1 p-3 text-sm hover:bg-slate-50">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{c.subject}</span>
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{c.status}</span>
                </div>
                <span className="text-xs text-slate-400">
                  {c.caseNumber} · {c.category} · {new Date(c.createdAt).toLocaleDateString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function NewCaseForm({ restaurantId, onCreated }: { restaurantId: string; onCreated: () => Promise<void> }) {
  const [category, setCategory] = useState<SupportCaseSummary['category']>('PAYMENT');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await supportApi.createRestaurant(
        {
          category,
          subject: subject.trim(),
          description: description.trim(),
          orderNumber: orderNumber.trim() || undefined,
        },
        restaurantId,
      );
      await onCreated();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-3 rounded-lg border border-slate-200 p-4">
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as SupportCaseSummary['category'])}
        className="input"
      >
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <input
        required
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Subject"
        maxLength={200}
        className="input"
      />
      <textarea
        required
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Describe the issue…"
        rows={4}
        maxLength={5000}
        className="input"
      />
      <input
        value={orderNumber}
        onChange={(e) => setOrderNumber(e.target.value)}
        placeholder="Order number (optional)"
        className="input"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button type="submit" disabled={saving} className="btn-primary w-fit">
        {saving ? 'Submitting…' : 'Submit'}
      </button>
    </form>
  );
}
