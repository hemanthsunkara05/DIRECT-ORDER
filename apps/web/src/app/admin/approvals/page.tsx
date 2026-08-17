'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminGuard } from '@/lib/auth/admin-guard';
import {
  ApiError,
  adminApi,
  type AdminRestaurant,
  type AdminRestaurantDetail,
} from '@/lib/api-client';
import { ReasonModal } from '@/components/ui/ReasonModal';

export default function AdminApprovalsPage() {
  return (
    <AdminGuard>
      <ApprovalsQueue />
    </AdminGuard>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

/**
 * Phase 21a — dedicated queue view, kept separate from `/admin/restaurants`
 * per explicit user decision during `/plan-design-review` (the canonical
 * design reference has no separate approvals page, but the user chose to
 * keep this one). FIFO order (`order=oldest`, sorted by `submittedAt`) —
 * a resubmitted restaurant reviews by its resubmission time, not its
 * original creation time. Detail (address/branding/menu) is fetched
 * per-row on expand via `GET :id/detail`, not eagerly for the whole list.
 */
function ApprovalsQueue() {
  const [restaurants, setRestaurants] = useState<AdminRestaurant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminRestaurantDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await adminApi.restaurants.list({ status: 'PENDING_APPROVAL', order: 'oldest' });
      setRestaurants(page.items);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await adminApi.restaurants.detail(id));
    } catch (err) {
      setDetailError(formatError(err));
    }
  }

  async function handleApprove(id: string) {
    setBusyId(id);
    try {
      await adminApi.restaurants.approve(id);
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
      }
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(reason: string) {
    if (!rejectingId) return;
    const id = rejectingId;
    setBusyId(id);
    try {
      await adminApi.restaurants.reject(id, reason);
      setRejectingId(null);
      if (expandedId === id) {
        setExpandedId(null);
        setDetail(null);
      }
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="mb-2 text-xl font-semibold">Approvals</h1>
      <p className="mb-2 text-sm text-slate-500">
        Restaurants awaiting a decision, oldest submission first. Expand a row for everything
        needed to decide — address, menu, and branding.
      </p>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <ul className="flex flex-col gap-2">
        {restaurants?.map((r) => (
          <li key={r.id} className="rounded-md border border-slate-200">
            <div className="flex items-center justify-between gap-3 p-3">
              <button
                type="button"
                onClick={() => void toggleExpand(r.id)}
                className="flex-1 text-left"
              >
                <span className="font-medium text-slate-900">{r.name}</span>
                {r.submittedAt && (
                  <span className="ml-2 text-xs text-slate-400">
                    submitted {new Date(r.submittedAt).toLocaleDateString()}
                  </span>
                )}
              </button>
              <div className="flex shrink-0 gap-3">
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
                  onClick={() => setRejectingId(r.id)}
                  className="text-red-600 underline disabled:cursor-not-allowed"
                >
                  Reject
                </button>
              </div>
            </div>

            {expandedId === r.id && (
              <div className="border-t border-slate-100 bg-slate-50 p-3 text-sm">
                {detailError && <p className="text-red-600">{detailError}</p>}
                {!detailError && !detail && <p className="text-slate-400">Loading…</p>}
                {detail && <RestaurantDetailView detail={detail} />}
              </div>
            )}
          </li>
        ))}
      </ul>
      {restaurants !== null && restaurants.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">No restaurants awaiting approval.</p>
      )}

      {rejectingId && (
        <ReasonModal
          title="Reject restaurant"
          consequence="The restaurant will be notified and can fix the issue and resubmit."
          confirmLabel="Reject"
          confirmTone="error"
          onConfirm={handleReject}
          onCancel={() => setRejectingId(null)}
        />
      )}
    </main>
  );
}

function RestaurantDetailView({ detail }: { detail: AdminRestaurantDetail }) {
  const { address, branding, menuSummary } = detail;
  return (
    <div className="flex flex-col gap-3">
      {detail.description && <p className="text-slate-700">{detail.description}</p>}
      <div>
        <h3 className="text-xs font-semibold uppercase text-slate-400">Address</h3>
        {address ? (
          <p className="text-slate-700">
            {[address.line1, address.line2, address.locality, address.city, address.state, address.postalCode]
              .filter(Boolean)
              .join(', ')}
          </p>
        ) : (
          <p className="text-slate-400">No address on file.</p>
        )}
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase text-slate-400">Menu</h3>
        <p className="text-slate-700">
          {menuSummary.categoryCount} categor{menuSummary.categoryCount === 1 ? 'y' : 'ies'},{' '}
          {menuSummary.itemCount} item{menuSummary.itemCount === 1 ? '' : 's'}
        </p>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase text-slate-400">Branding</h3>
        {branding?.tagline ? (
          <p className="text-slate-700">{branding.tagline}</p>
        ) : (
          <p className="text-slate-400">No tagline set.</p>
        )}
      </div>
    </div>
  );
}
