'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatINR } from '@direct-order/money';
import { AdminGuard } from '@/lib/auth/admin-guard';
import { adminApi, type CommandCenterView } from '@/lib/api-client';

const FUNNEL_STAGES: { key: keyof CommandCenterView['funnel']; label: string }[] = [
  { key: 'PLACED', label: 'Placed' },
  { key: 'ACCEPTED', label: 'Accepted' },
  { key: 'PREPARING', label: 'Preparing' },
  { key: 'READY_FOR_PICKUP', label: 'Ready' },
  { key: 'OUT_FOR_DELIVERY', label: 'Out for delivery' },
  { key: 'DELIVERED_TODAY', label: 'Delivered today' },
];

export default function AdminOverviewPage() {
  return (
    <AdminGuard>
      <CommandCenter />
    </AdminGuard>
  );
}

/**
 * Admin command center (Phase 23a) — every number here comes from
 * `GET /admin/overview/command-center`, which reads either
 * `DailyPlatformMetrics` rollups (KPIs) or cheap indexed live queries
 * (funnel/alerts/top-restaurants). Deliberately does NOT include a
 * geography view, fraud scoring, forecasting, or a delivery-provider
 * console — none of those have real backing data in this system yet
 * (see TODOS.md's "Future stages" section for what each is gated on).
 */
function CommandCenter() {
  const [data, setData] = useState<CommandCenterView | null>(null);
  const [health, setHealth] = useState<Awaited<ReturnType<typeof adminApi.health>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void adminApi
      .commandCenter()
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load.'));
    void adminApi.health().then(setHealth);
  }, []);

  if (error) {
    return (
      <main className="mx-auto max-w-5xl p-6">
        <p className="text-sm text-red-600">{error}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink-900">Admin</h1>
        {health && (
          <p className="font-mono text-xs text-ink-400">
            DB {health.database.status === 'ok' ? '●' : '✕'} · Redis{' '}
            {health.redis.status === 'ok' ? '●' : '✕'}
          </p>
        )}
      </div>

      {data === null ? (
        <p className="text-sm text-ink-500">Loading…</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiTile
              label="Orders today"
              value={String(data.kpis.ordersToday)}
              comparison={data.kpis.ordersYesterday}
              suffix=" vs. yesterday"
            />
            <KpiTile label="Orders this week" value={String(data.kpis.ordersThisWeek)} />
            <KpiTile
              label="GMV today"
              value={formatINR(BigInt(data.kpis.gmvTodayMinor))}
              comparison={
                data.kpis.gmvYesterdayMinor === null
                  ? null
                  : Number(BigInt(data.kpis.gmvTodayMinor) - BigInt(data.kpis.gmvYesterdayMinor))
              }
              suffix=" vs. yesterday"
            />
            <KpiTile label="GMV this week" value={formatINR(BigInt(data.kpis.gmvThisWeekMinor))} />
            <KpiTile
              label="Platform fee revenue today"
              value={formatINR(BigInt(data.kpis.platformFeeRevenueTodayMinor))}
            />
            <KpiTile
              label="Platform fee revenue this week"
              value={formatINR(BigInt(data.kpis.platformFeeRevenueThisWeekMinor))}
            />
            <KpiTile label="Restaurants live" value={String(data.kpis.restaurantsLive)} tone="fresh" />
            <KpiTile
              label="Pending approval"
              value={String(data.kpis.restaurantsPendingApproval)}
              tone={data.kpis.restaurantsPendingApproval > 0 ? 'warn' : undefined}
            />
          </div>

          <section className="rounded-card border border-ink-200 bg-surface p-4 shadow-1">
            <h2 className="mb-3 text-sm font-semibold text-ink-500">Order lifecycle (today)</h2>
            <div className="flex flex-wrap items-stretch gap-2">
              {FUNNEL_STAGES.map((stage) => (
                <Link
                  key={stage.key}
                  href={`/admin/orders${stage.key.endsWith('_TODAY') ? '' : `?status=${stage.key}`}`}
                  className="flex min-w-[100px] flex-1 flex-col gap-1 rounded-ctrl border border-ink-200 px-3 py-2 hover:border-brand-600 hover:bg-brand-100"
                >
                  <span className="text-xs text-ink-500">{stage.label}</span>
                  <span className="font-mono text-lg font-bold text-ink-900">
                    {data.funnel[stage.key]}
                  </span>
                </Link>
              ))}
              <div className="flex min-w-[100px] flex-1 flex-col gap-1 rounded-ctrl border border-error-100 bg-error-100 px-3 py-2">
                <span className="text-xs text-error">Cancelled/rejected today</span>
                <span className="font-mono text-lg font-bold text-error">
                  {data.funnel.CANCELLED_TODAY + data.funnel.REJECTED_TODAY}
                </span>
              </div>
            </div>
          </section>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <section className="rounded-card border border-ink-200 bg-surface p-4 shadow-1">
              <h2 className="mb-3 text-sm font-semibold text-ink-500">Priority alerts</h2>
              {data.alerts.stuckOrders.length === 0 && data.alerts.overdueApprovals.length === 0 ? (
                <p className="text-sm text-ink-400">Nothing needs attention right now.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {data.alerts.stuckOrders.map((o) => (
                    <li key={o.id}>
                      <Link
                        href={`/admin/orders?restaurantId=${o.restaurantId}`}
                        className="flex items-center justify-between rounded-ctrl border border-warn-100 bg-warn-100 px-3 py-2 text-sm hover:border-warn-700"
                      >
                        <span className="text-ink-800">
                          {o.orderNumber} stuck in {o.status}
                        </span>
                        <span className="font-mono text-xs text-warn-700">
                          {o.minutesSinceUpdate}m
                        </span>
                      </Link>
                    </li>
                  ))}
                  {data.alerts.overdueApprovals.map((r) => (
                    <li key={r.id}>
                      <Link
                        href="/admin/approvals"
                        className="flex items-center justify-between rounded-ctrl border border-warn-100 bg-warn-100 px-3 py-2 text-sm hover:border-warn-700"
                      >
                        <span className="text-ink-800">{r.name} awaiting approval</span>
                        <span className="font-mono text-xs text-warn-700">
                          {r.hoursWaiting}h
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="rounded-card border border-ink-200 bg-surface p-4 shadow-1">
              <h2 className="mb-3 text-sm font-semibold text-ink-500">Top restaurants (last 7 days)</h2>
              {data.topRestaurants.length === 0 ? (
                <p className="text-sm text-ink-400">No orders in the last 7 days.</p>
              ) : (
                <table className="w-full text-left text-sm" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <thead>
                    <tr className="border-b border-ink-200 text-xs text-ink-400">
                      <th className="py-1.5">Restaurant</th>
                      <th className="py-1.5 text-right">Orders</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topRestaurants.map((r) => (
                      <tr key={r.restaurantId} className="border-b border-ink-100 last:border-0">
                        <td className="py-1.5">
                          <Link
                            href={`/admin/orders?restaurantId=${r.restaurantId}`}
                            className="text-ink-800 hover:text-brand-600 hover:underline"
                          >
                            {r.name}
                          </Link>
                        </td>
                        <td className="py-1.5 text-right font-mono">{r.orderCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  );
}

function KpiTile({
  label,
  value,
  comparison,
  suffix,
  tone,
}: {
  label: string;
  value: string;
  comparison?: number | null;
  suffix?: string;
  tone?: 'fresh' | 'warn';
}) {
  const toneClass = tone === 'fresh' ? 'text-fresh-700' : tone === 'warn' ? 'text-warn-700' : 'text-ink-900';
  return (
    <div className="rounded-card border border-ink-200 bg-surface p-4 shadow-1">
      <p className="text-xs text-ink-400">{label}</p>
      <p className={`text-lg font-bold ${toneClass}`} style={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </p>
      {comparison !== undefined && comparison !== null && (
        <p className={`mt-0.5 text-xs ${comparison >= 0 ? 'text-fresh-700' : 'text-error'}`}>
          {comparison >= 0 ? '▲' : '▼'} {Math.abs(comparison)}
          {suffix}
        </p>
      )}
    </div>
  );
}
