'use client';

import { useState } from 'react';
import { ApiError, restaurantOrdersApi } from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoKey(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function startOfMonthKey(monthsAgo: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo, 1);
  return d.toISOString().slice(0, 10);
}

function endOfMonthKey(monthsAgo: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsAgo + 1, 0);
  return d.toISOString().slice(0, 10);
}

const PRESETS: { label: string; from: () => string; to: () => string }[] = [
  { label: 'Today', from: () => todayKey(), to: () => todayKey() },
  { label: 'Last 7 days', from: () => daysAgoKey(6), to: () => todayKey() },
  { label: 'Last 30 days', from: () => daysAgoKey(29), to: () => todayKey() },
  { label: 'This month', from: () => startOfMonthKey(0), to: () => todayKey() },
  { label: 'Last month', from: () => startOfMonthKey(1), to: () => endOfMonthKey(1) },
];

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

export default function OrderHistoryPage() {
  return (
    <ProtectedRoute>
      <OrderHistory />
    </ProtectedRoute>
  );
}

/**
 * Order history / export (docs feedback: "rest orders have to be
 * stored, month data should be stored in excel kind of data") — the
 * live orders queue only shows today (see restaurant/orders/page.tsx's
 * own doc comment); this page is where every earlier day's orders
 * still live, as a downloadable CSV for a chosen date range rather
 * than a second live-scrolling list. Excel/Sheets opens the file
 * directly — no in-app spreadsheet viewer needed for what is
 * fundamentally a records/bookkeeping need, not a live-operations one.
 */
function OrderHistory() {
  const { user, activeRestaurantId } = useSession();
  const restaurantId = activeRestaurantId ?? undefined;
  const membership = user?.restaurantMemberships.find((m) => m.restaurantId === activeRestaurantId);
  const canExport = membership?.role === 'MANAGER' || membership?.role === 'OWNER';

  const [from, setFrom] = useState(daysAgoKey(29));
  const [to, setTo] = useState(todayKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  async function handleExport() {
    if (!restaurantId) return;
    setBusy(true);
    setError(null);
    setDownloaded(false);
    try {
      await restaurantOrdersApi.exportCsv(from, to, restaurantId);
      setDownloaded(true);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  if (!restaurantId) {
    return <main className="p-6 text-sm text-ink-500">Loading…</main>;
  }

  if (!canExport) {
    return (
      <main className="mx-auto max-w-lg p-6">
        <h1 className="mb-2 text-xl font-bold text-ink-900">Order history</h1>
        <p className="text-sm text-ink-500">
          Only managers and owners can export order history. Ask a manager for a copy.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg p-6">
      <h1 className="mb-1 text-xl font-bold text-ink-900">Order history</h1>
      <p className="mb-6 text-sm text-ink-500">
        Live orders only shows today. For anything earlier, download a CSV for the date range you
        need — it opens directly in Excel or Google Sheets.
      </p>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => {
              setFrom(preset.from());
              setTo(preset.to());
            }}
            className="rounded-pill border border-ink-200 px-3 py-1 text-xs font-medium text-ink-700 hover:bg-ink-100"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink-700">
          From
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-ctrl border border-ink-200 px-2.5 py-1.5 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-ink-700">
          To
          <input
            type="date"
            value={to}
            min={from}
            max={todayKey()}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-ctrl border border-ink-200 px-2.5 py-1.5 text-sm"
          />
        </label>
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => void handleExport()}
        className="rounded-ctrl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? 'Preparing CSV…' : 'Download CSV'}
      </button>

      {downloaded && !error && (
        <p className="mt-3 text-sm font-medium text-fresh-700">Downloaded — check your browser's downloads.</p>
      )}
      {error && <p className="mt-3 text-sm font-medium text-error">{error}</p>}
    </main>
  );
}
