'use client';

import { useEffect, useState } from 'react';
import { formatINR } from '@direct-order/money';
import { AdminGuard } from '@/lib/auth/admin-guard';
import { adminApi } from '@/lib/api-client';

export default function AdminOverviewPage() {
  return (
    <AdminGuard>
      <OverviewDashboard />
    </AdminGuard>
  );
}

function OverviewDashboard() {
  const [overview, setOverview] = useState<Awaited<ReturnType<typeof adminApi.overview>> | null>(
    null,
  );
  const [health, setHealth] = useState<Awaited<ReturnType<typeof adminApi.health>> | null>(null);

  useEffect(() => {
    void adminApi.overview().then(setOverview);
    void adminApi.health().then(setHealth);
  }, []);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-2 text-xl font-semibold">Admin</h1>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-slate-200 p-4">
          <p className="text-xs text-slate-400">Active admins</p>
          <p className="text-2xl font-semibold">{overview?.activeAdmins ?? '—'}</p>
        </div>
        <div className="rounded-lg border border-slate-200 p-4">
          <p className="text-xs text-slate-400">System health</p>
          {health ? (
            <p className="text-sm">
              DB:{' '}
              <span className={health.database.status === 'ok' ? 'text-green-600' : 'text-red-600'}>
                {health.database.status}
              </span>
              {' · '}
              Redis:{' '}
              <span className={health.redis.status === 'ok' ? 'text-green-600' : 'text-red-600'}>
                {health.redis.status}
              </span>
            </p>
          ) : (
            <p className="text-sm text-slate-400">Checking…</p>
          )}
        </div>
        <div className="rounded-lg border border-slate-200 p-4">
          <p className="text-xs text-slate-400">Support cases opened (as of {overview?.metrics.asOfDate ?? '—'})</p>
          <p className="text-2xl font-semibold">{overview?.metrics.latest?.supportCasesOpened ?? '—'}</p>
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-slate-200 p-4">
        <p className="mb-2 text-sm font-semibold">Restaurants by status</p>
        {overview ? (
          <ul className="flex flex-wrap gap-4 text-sm">
            {Object.entries(overview.restaurantsByStatus).map(([status, count]) => (
              <li key={status} className="text-slate-600">
                {status}: <span className="font-medium text-slate-900">{count}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-400">Loading…</p>
        )}
      </div>

      <div className="mt-6 rounded-lg border border-slate-200 p-4">
        <p className="mb-2 text-sm font-semibold">
          Platform metrics {overview?.metrics.asOfDate ? `(as of ${overview.metrics.asOfDate})` : ''}
        </p>
        {overview === null ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : overview.metrics.latest === null ? (
          <p className="text-sm text-slate-400">No rollups computed yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Metric label="Orders placed" value={String(overview.metrics.latest.ordersPlaced)} />
            <Metric label="Orders completed" value={String(overview.metrics.latest.ordersCompleted)} />
            <Metric label="Orders cancelled" value={String(overview.metrics.latest.ordersCancelled)} />
            <Metric label="Orders rejected" value={String(overview.metrics.latest.ordersRejected)} />
            <Metric label="Gross order value" value={formatINR(BigInt(overview.metrics.latest.grossOrderValueMinor))} />
            <Metric label="Net order value" value={formatINR(BigInt(overview.metrics.latest.netOrderValueMinor))} />
            <Metric label="Refunds" value={formatINR(BigInt(overview.metrics.latest.refundMinor))} />
            <Metric
              label="Payment success"
              value={
                overview.metrics.latest.paymentsAttempted > 0
                  ? `${overview.metrics.latest.paymentsSucceeded}/${overview.metrics.latest.paymentsAttempted}`
                  : '—'
              }
            />
            <Metric
              label="Delivery success"
              value={
                overview.metrics.latest.deliveriesAttempted > 0
                  ? `${overview.metrics.latest.deliveriesSucceeded}/${overview.metrics.latest.deliveriesAttempted}`
                  : '—'
              }
            />
          </div>
        )}
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-slate-400">{label}</p>
      <p className="font-medium text-slate-900">{value}</p>
    </div>
  );
}
