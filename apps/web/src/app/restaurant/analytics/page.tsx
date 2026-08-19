'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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

/**
 * Renders `GET /restaurant/analytics/overview` — reads only from
 * `DailyRestaurantMetrics` rollups, never a live table scan (docs/13's
 * "dashboards from rollups"). Today's row IS included now
 * (`AnalyticsRollupService` rolls up today as well as yesterday, on an
 * hourly sweep plus once on server startup — a same-day action like a
 * reject or cancel shows up here within the hour, not "check back
 * tomorrow").
 */
function AnalyticsView() {
  const { user } = useSession();
  const restaurantId = user?.restaurantMemberships.find((m) => m.role !== 'STAFF')?.restaurantId;

  const [days, setDays] = useState<RestaurantDailyMetrics[] | null>(null);
  const [summary, setSummary] = useState<RestaurantAnalyticsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState(30);
  const todayKey = useMemo(() => new Date().toISOString().slice(0, 10), []);

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

  const derived = useMemo(() => {
    if (!summary) return null;
    const decided = summary.ordersCompleted + summary.ordersCancelled + summary.ordersRejected;
    const completionRate = decided > 0 ? Math.round((summary.ordersCompleted / decided) * 100) : null;
    const rejectionRate =
      summary.ordersPlaced > 0 ? Math.round((summary.ordersRejected / summary.ordersPlaced) * 100) : null;
    const cancellationRate =
      summary.ordersPlaced > 0 ? Math.round((summary.ordersCancelled / summary.ordersPlaced) * 100) : null;
    return { completionRate, rejectionRate, cancellationRate };
  }, [summary]);

  const chartRows = useMemo(() => (days ? [...days].reverse() : []), [days]);
  const maxGross = useMemo(
    () => chartRows.reduce((max, d) => Math.max(max, Number(BigInt(d.grossOrderValueMinor))), 0),
    [chartRows],
  );

  if (!restaurantId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-ink-500">You don&apos;t manage a restaurant.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">Analytics</h1>
        <select
          value={range}
          onChange={(e) => setRange(Number(e.target.value))}
          className="rounded-ctrl border border-ink-200 bg-surface px-2.5 py-1.5 text-sm font-medium text-ink-700"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
      {error && <p className="text-sm font-medium text-error">{error}</p>}

      {summary === null ? (
        <p className="text-sm text-ink-500">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Orders placed" value={String(summary.ordersPlaced)} />
            <Stat
              label="Completion rate"
              value={derived?.completionRate === null ? '—' : `${derived?.completionRate}%`}
              tone="fresh"
            />
            <Stat
              label="Rejection rate"
              value={derived?.rejectionRate === null ? '—' : `${derived?.rejectionRate}%`}
              tone={derived?.rejectionRate && derived.rejectionRate > 10 ? 'error' : undefined}
            />
            <Stat
              label="Cancellation rate"
              value={derived?.cancellationRate === null ? '—' : `${derived?.cancellationRate}%`}
              tone={derived?.cancellationRate && derived.cancellationRate > 5 ? 'error' : undefined}
            />
            <Stat label="Gross value" value={formatINR(BigInt(summary.grossOrderValueMinor))} />
            <Stat label="Net value" value={formatINR(BigInt(summary.netOrderValueMinor))} />
            <Stat label="Avg order value" value={formatINR(BigInt(summary.avgOrderValueMinor))} />
            <Stat label="Refunds" value={formatINR(BigInt(summary.refundMinor))} tone={summary.refundMinor !== '0' ? 'warn' : undefined} />
          </div>

          {chartRows.length > 0 && maxGross > 0 && (
            <section className="rounded-card border border-ink-200 bg-surface p-4 shadow-1">
              <h2 className="mb-3 text-sm font-semibold text-ink-500">Gross value trend</h2>
              <div className="flex h-28 items-end gap-1">
                {chartRows.map((d) => {
                  const value = Number(BigInt(d.grossOrderValueMinor));
                  const heightPct = maxGross > 0 ? Math.max((value / maxGross) * 100, value > 0 ? 4 : 0) : 0;
                  const isToday = d.date === todayKey;
                  return (
                    <div
                      key={d.date}
                      className="group relative flex-1"
                      title={`${d.date}: ${formatINR(BigInt(d.grossOrderValueMinor))}`}
                    >
                      <div
                        className={`w-full rounded-t-sm transition-colors ${
                          isToday ? 'bg-brand-600' : 'bg-brand-200 group-hover:bg-brand-400'
                        }`}
                        style={{ height: `${heightPct}%`, minHeight: value > 0 ? '2px' : '0' }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-1.5 flex justify-between font-mono text-[10px] text-ink-400">
                <span>{chartRows[0]?.date}</span>
                <span>{chartRows.at(-1)?.date}</span>
              </div>
            </section>
          )}
        </>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-ink-500">Daily breakdown</h2>
        {days === null ? (
          <p className="text-sm text-ink-500">Loading…</p>
        ) : days.length === 0 ? (
          <p className="text-sm text-ink-500">No rollups computed yet — check back shortly.</p>
        ) : (
          <div className="overflow-x-auto rounded-card border border-ink-200 bg-surface shadow-1">
            <table className="w-full text-left text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr className="border-b border-ink-200 text-xs text-ink-400">
                  <th className="py-2 pl-4">Date</th>
                  <th>Placed</th>
                  <th>Completed</th>
                  <th>Cancelled</th>
                  <th>Rejected</th>
                  <th>Gross</th>
                  <th>Net</th>
                  <th className="pr-4">Avg prep</th>
                </tr>
              </thead>
              <tbody>
                {chartRows.map((d) => {
                  const isToday = d.date === todayKey;
                  return (
                    <tr
                      key={d.date}
                      className={`border-b border-ink-100 last:border-0 ${isToday ? 'bg-brand-100' : ''}`}
                    >
                      <td className="py-2 pl-4 font-medium text-ink-900">
                        {d.date}
                        {isToday && (
                          <span className="ml-1.5 rounded-pill bg-brand-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                            Today
                          </span>
                        )}
                      </td>
                      <td>{d.ordersPlaced}</td>
                      <td className="text-fresh-700">{d.ordersCompleted}</td>
                      <td className={d.ordersCancelled > 0 ? 'font-semibold text-error' : ''}>
                        {d.ordersCancelled}
                      </td>
                      <td className={d.ordersRejected > 0 ? 'font-semibold text-error' : ''}>
                        {d.ordersRejected}
                      </td>
                      <td>{formatINR(BigInt(d.grossOrderValueMinor))}</td>
                      <td>{formatINR(BigInt(d.netOrderValueMinor))}</td>
                      {/* eslint-disable-next-line no-restricted-syntax -- not money: prep time in minutes */}
                      <td className="pr-4">
                        {d.avgPrepSeconds > 0 ? `${Math.round(d.avgPrepSeconds / 60)} min` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'fresh' | 'warn' | 'error';
}) {
  const toneClass =
    tone === 'fresh'
      ? 'text-fresh-700'
      : tone === 'warn'
        ? 'text-warn-700'
        : tone === 'error'
          ? 'text-error'
          : 'text-ink-900';
  return (
    <div className="rounded-card border border-ink-200 bg-surface p-4 shadow-1">
      <p className="text-xs text-ink-400">{label}</p>
      <p className={`text-lg font-bold ${toneClass}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </p>
    </div>
  );
}
