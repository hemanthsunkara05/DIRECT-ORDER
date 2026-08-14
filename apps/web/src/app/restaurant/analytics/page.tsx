'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatINR } from '@direct-order/money';
import { ApiError, analyticsApi, type RestaurantAnalyticsSummary, type RestaurantDailyMetrics } from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';

export default function RestaurantAnalyticsPage() {
  return (
    <ProtectedRoute>
      <AnalyticsView />
    </ProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

/** Renders exclusively what `GET /restaurant/analytics/overview` returns — that endpoint reads only from `DailyRestaurantMetrics` rollups, never a live table scan (docs/13's "dashboards from rollups"), so a day is only ever "as of yesterday" here, never a still-accumulating "today". */
function AnalyticsView() {
  const { user } = useSession();
  const restaurantId = user?.restaurantMemberships.find((m) => m.role !== 'STAFF')?.restaurantId;

  const [days, setDays] = useState<RestaurantDailyMetrics[] | null>(null);
  const [summary, setSummary] = useState<RestaurantAnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState(30);

  const load = useCallback(async () => {
    if (!restaurantId) return;
    try {
      const res = await analyticsApi.restaurantOverview({ days: range }, restaurantId);
      setDays(res.days);
      setSummary(res.summary);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurantId, range]);

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
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col gap-6 p-8">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Analytics</h1>
        <select
          value={range}
          onChange={(e) => setRange(Number(e.target.value))}
          className="rounded-md border border-slate-300 px-2 py-1 text-sm"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {summary === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Orders placed" value={String(summary.ordersPlaced)} />
          <Stat label="Orders completed" value={String(summary.ordersCompleted)} />
          <Stat label="Orders cancelled" value={String(summary.ordersCancelled)} />
          <Stat label="Orders rejected" value={String(summary.ordersRejected)} />
          <Stat label="Gross value" value={formatINR(BigInt(summary.grossOrderValueMinor))} />
          <Stat label="Net value" value={formatINR(BigInt(summary.netOrderValueMinor))} />
          <Stat label="Discounts" value={formatINR(BigInt(summary.discountMinor))} />
          <Stat label="Refunds" value={formatINR(BigInt(summary.refundMinor))} />
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-slate-500">Daily breakdown</h2>
        {days === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : days.length === 0 ? (
          <p className="text-sm text-slate-500">No rollups computed yet — check back tomorrow.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-400">
                  <th className="py-2">Date</th>
                  <th>Placed</th>
                  <th>Completed</th>
                  <th>Cancelled</th>
                  <th>Rejected</th>
                  <th>Gross</th>
                  <th>Net</th>
                  <th>Avg prep</th>
                </tr>
              </thead>
              <tbody>
                {[...days].reverse().map((d) => (
                  <tr key={d.date} className="border-b border-slate-100">
                    <td className="py-2">{d.date}</td>
                    <td>{d.ordersPlaced}</td>
                    <td>{d.ordersCompleted}</td>
                    <td>{d.ordersCancelled}</td>
                    <td>{d.ordersRejected}</td>
                    <td>{formatINR(BigInt(d.grossOrderValueMinor))}</td>
                    <td>{formatINR(BigInt(d.netOrderValueMinor))}</td>
                    {/* eslint-disable-next-line no-restricted-syntax -- not money: prep time in minutes */}
                    <td>{d.avgPrepSeconds > 0 ? `${Math.round(d.avgPrepSeconds / 60)} min` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <p className="text-xs text-slate-400">{label}</p>
      <p className="text-lg font-semibold">{value}</p>
    </div>
  );
}
