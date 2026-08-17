'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminGuard } from '@/lib/auth/admin-guard';
import { ApiError, adminApi, type AdminRestaurant } from '@/lib/api-client';
import { ReasonModal } from '@/components/ui/ReasonModal';
import { StatusPill, RESTAURANT_STATUS_TONE, statusLabel } from '@/components/ui/StatusPill';

type PendingReasonAction = { kind: 'reject' | 'suspend'; restaurantId: string };

export default function AdminRestaurantsPage() {
  return (
    <AdminGuard>
      <RestaurantsDashboard />
    </AdminGuard>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

function RestaurantsDashboard() {
  const [restaurants, setRestaurants] = useState<AdminRestaurant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingReason, setPendingReason] = useState<PendingReasonAction | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await adminApi.restaurants.list();
      setRestaurants(page.items);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleApprove(id: string) {
    setBusyId(id);
    try {
      await adminApi.restaurants.approve(id);
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleReasonConfirm(reason: string) {
    if (!pendingReason) return;
    const { kind, restaurantId } = pendingReason;
    setBusyId(restaurantId);
    try {
      if (kind === 'reject') {
        await adminApi.restaurants.reject(restaurantId, reason);
      } else {
        await adminApi.restaurants.suspend(restaurantId, reason);
      }
      setPendingReason(null);
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleReinstate(id: string) {
    setBusyId(id);
    try {
      await adminApi.restaurants.reinstate(id);
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-2 text-xl font-semibold">Restaurants</h1>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-400">
            <th className="py-2">Name</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {restaurants?.map((r) => (
            <tr key={r.id} className="border-b border-slate-100">
              <td className="py-2">{r.name}</td>
              <td>
                <StatusPill label={statusLabel(r.status)} tone={RESTAURANT_STATUS_TONE[r.status] ?? 'ink'} />
              </td>
              <td className="flex gap-2 py-2">
                {r.status === 'PENDING_APPROVAL' && (
                  <>
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => void handleApprove(r.id)}
                      className="text-indigo-600 underline disabled:cursor-not-allowed"
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      disabled={busyId === r.id}
                      onClick={() => setPendingReason({ kind: 'reject', restaurantId: r.id })}
                      className="text-red-600 underline disabled:cursor-not-allowed"
                    >
                      Reject
                    </button>
                  </>
                )}
                {r.status === 'ACTIVE' && (
                  <button
                    type="button"
                    disabled={busyId === r.id}
                    onClick={() => setPendingReason({ kind: 'suspend', restaurantId: r.id })}
                    className="text-red-600 underline disabled:cursor-not-allowed"
                  >
                    Suspend
                  </button>
                )}
                {r.status === 'SUSPENDED' && (
                  <button
                    type="button"
                    disabled={busyId === r.id}
                    onClick={() => void handleReinstate(r.id)}
                    className="text-indigo-600 underline disabled:cursor-not-allowed"
                  >
                    Reinstate
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {restaurants !== null && restaurants.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">No restaurants.</p>
      )}

      {pendingReason && (
        <ReasonModal
          title={pendingReason.kind === 'reject' ? 'Reject restaurant' : 'Suspend restaurant'}
          consequence={
            pendingReason.kind === 'reject'
              ? 'The restaurant will be notified and can fix the issue and resubmit.'
              : 'The restaurant stops accepting new orders immediately. Orders already placed are unaffected.'
          }
          confirmLabel={pendingReason.kind === 'reject' ? 'Reject' : 'Suspend'}
          confirmTone="error"
          onConfirm={handleReasonConfirm}
          onCancel={() => setPendingReason(null)}
        />
      )}
    </main>
  );
}
