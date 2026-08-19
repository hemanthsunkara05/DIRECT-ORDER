'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { formatINR } from '@direct-order/money';
import { AdminGuard } from '@/lib/auth/admin-guard';
import {
  ApiError,
  adminApi,
  type AdminOrderDetail,
  type AdminOrderDirectoryEntry,
  type AdminOrderSummary,
} from '@/lib/api-client';

const CANCELLABLE = new Set(['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']);
const UNKNOWN_CITY = 'Unknown city';

/** Same map as `restaurant/orders/page.tsx`'s `DELIVERY_STATUS_LABEL` — reused verbatim (docs feedback: mirror, don't reinvent). */
const DELIVERY_STATUS_LABEL: Record<string, string> = {
  PENDING_CREATION: 'Arranging delivery…',
  CREATED: 'Delivery arranged',
  CREATION_FAILED: 'Could not arrange delivery',
  SEARCHING_COURIER: 'Looking for a courier',
  COURIER_ASSIGNED: 'Courier assigned',
  AT_PICKUP: 'Courier is at the restaurant',
  PICKED_UP: 'Picked up by courier',
  NO_COURIER_FOUND: 'No courier available',
  DELIVERED: 'Delivered',
  CANCELLED: 'Delivery cancelled',
  FAILED: 'Delivery failed',
};

export default function AdminOrdersPage() {
  return (
    <AdminGuard>
      <OrdersDashboard />
    </AdminGuard>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

/**
 * City -> restaurant -> orders drill-down (docs feedback: "orders
 * should be sorted according to the restaurants. city -> restaurant ->
 * orders") — a flat cross-tenant order list doesn't scale past a
 * handful of restaurants, so the directory (city/restaurant with order
 * counts, `GET /admin/orders/directory`) is the landing view; picking a
 * restaurant drops into the existing paginated order list, now
 * pre-filtered to just that restaurant.
 */
function OrdersDashboard() {
  // Seeded from the command center's deep links (`?status=` from a
  // funnel stage, `?restaurantId=` from an alert/top-restaurant row) —
  // read once on mount, not kept in sync with the URL afterward (this
  // page's own filter UI already owns the state from here on).
  const searchParams = useSearchParams();
  const [statusFilter, setStatusFilter] = useState(() =>
    (searchParams.get('status') ?? '').toUpperCase(),
  );
  const [selectedRestaurant, setSelectedRestaurant] = useState<{ id: string; name: string } | null>(
    null,
  );

  useEffect(() => {
    const restaurantId = searchParams.get('restaurantId');
    if (!restaurantId) return;
    void adminApi.orders.directory({}).then((rows) => {
      const match = rows.find((r) => r.restaurantId === restaurantId);
      setSelectedRestaurant({ id: restaurantId, name: match?.name ?? 'Restaurant' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read the deep link once, on mount
  }, []);
  // Lifted out of OrderDirectory (rather than local state there): that
  // component unmounts every time a restaurant is selected, so local
  // state would reset — and re-seed itself back open — on every single
  // trip back from a restaurant's order list ("dropping down after
  // every move"). Living here, it survives navigation between the two
  // views untouched.
  const [openCities, setOpenCities] = useState<Set<string>>(new Set());
  const [seededOpenCities, setSeededOpenCities] = useState(false);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Orders</h1>
        <input
          type="text"
          placeholder="Filter by status (e.g. PLACED)"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value.toUpperCase())}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
        />
      </div>

      {selectedRestaurant ? (
        <RestaurantOrders
          restaurant={selectedRestaurant}
          statusFilter={statusFilter}
          onBack={() => setSelectedRestaurant(null)}
        />
      ) : (
        <OrderDirectory
          statusFilter={statusFilter}
          openCities={openCities}
          setOpenCities={setOpenCities}
          seededOpenCities={seededOpenCities}
          setSeededOpenCities={setSeededOpenCities}
          onSelectRestaurant={(id, name) => setSelectedRestaurant({ id, name })}
        />
      )}
    </main>
  );
}

function OrderDirectory({
  statusFilter,
  openCities,
  setOpenCities,
  seededOpenCities,
  setSeededOpenCities,
  onSelectRestaurant,
}: {
  statusFilter: string;
  openCities: Set<string>;
  setOpenCities: React.Dispatch<React.SetStateAction<Set<string>>>;
  seededOpenCities: boolean;
  setSeededOpenCities: (v: boolean) => void;
  onSelectRestaurant: (id: string, name: string) => void;
}) {
  const [entries, setEntries] = useState<AdminOrderDirectoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const rows = await adminApi.orders.directory({ status: statusFilter || undefined });
      setEntries(rows);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  const cities = useMemo(() => {
    const map = new Map<string, AdminOrderDirectoryEntry[]>();
    for (const entry of entries ?? []) {
      const city = entry.city ?? UNKNOWN_CITY;
      const list = map.get(city) ?? [];
      list.push(entry);
      map.set(city, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => b.orderCount - a.orderCount || a.name.localeCompare(b.name));
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);

  // First load ONLY (guarded by the lifted `seededOpenCities` flag, not
  // just "openCities is currently empty" — an admin who manually
  // collapses every city ends up with an empty set too, and that must
  // stay collapsed, not get treated as "never seeded"): open every city
  // with at least one order so the tree isn't a wall of collapsed rows
  // to click through one by one. A city with zero orders stays
  // collapsed since there's nothing to see inside it.
  useEffect(() => {
    if (entries === null || seededOpenCities) return;
    const withOrders = cities
      .filter(([, list]) => list.some((r) => r.orderCount > 0))
      .map(([city]) => city);
    setOpenCities(new Set(withOrders));
    setSeededOpenCities(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only seed once, on first successful load
  }, [entries, seededOpenCities]);

  function toggleCity(city: string) {
    setOpenCities((prev) => {
      const next = new Set(prev);
      if (next.has(city)) next.delete(city);
      else next.add(city);
      return next;
    });
  }

  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (entries === null) return <p className="text-sm text-slate-500">Loading…</p>;
  if (entries.length === 0) return <p className="text-sm text-slate-500">No restaurants yet.</p>;

  const totalOrders = entries.reduce((sum, e) => sum + e.orderCount, 0);

  return (
    <div className="flex flex-col gap-3">
      {statusFilter && (
        <p className="text-xs text-slate-500">
          Counts below reflect the &quot;{statusFilter}&quot; filter · {totalOrders} matching order
          {totalOrders === 1 ? '' : 's'} total.
        </p>
      )}
      {cities.map(([city, restaurants]) => {
        const cityOrderCount = restaurants.reduce((sum, r) => sum + r.orderCount, 0);
        const isOpen = openCities.has(city);
        return (
          <div key={city} className="rounded-md border border-slate-200">
            <button
              type="button"
              onClick={() => toggleCity(city)}
              className="flex w-full items-center justify-between px-4 py-2.5 text-left"
            >
              <span className="text-sm font-semibold text-slate-900">
                {isOpen ? '▾' : '▸'} {city}
              </span>
              <span className="text-xs text-slate-400">
                {restaurants.length} restaurant{restaurants.length === 1 ? '' : 's'} ·{' '}
                {cityOrderCount} order{cityOrderCount === 1 ? '' : 's'}
              </span>
            </button>
            {isOpen && (
              <ul className="border-t border-slate-100">
                {restaurants.map((r) => (
                  <li key={r.restaurantId} className="border-t border-slate-50 first:border-t-0">
                    <button
                      type="button"
                      onClick={() => onSelectRestaurant(r.restaurantId, r.name)}
                      disabled={r.orderCount === 0}
                      className="flex w-full items-center justify-between px-6 py-2 text-left text-sm hover:bg-slate-50 disabled:cursor-default disabled:text-slate-400 disabled:hover:bg-transparent"
                    >
                      <span>{r.name}</span>
                      <span className="font-mono text-xs">{r.orderCount}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function RestaurantOrders({
  restaurant,
  statusFilter,
  onBack,
}: {
  restaurant: { id: string; name: string };
  statusFilter: string;
  onBack: () => void;
}) {
  const [orders, setOrders] = useState<AdminOrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminOrderDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await adminApi.orders.list({
        status: statusFilter || undefined,
        restaurantId: restaurant.id,
      });
      setOrders(page.items);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurant.id, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleExpand(orderId: string) {
    if (expandedId === orderId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(orderId);
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await adminApi.orders.detail(orderId));
    } catch (err) {
      setDetailError(formatError(err));
    }
  }

  async function handleCancel(id: string) {
    const reason = window.prompt(
      'Reason for cancelling this order (the customer will be refunded):',
    );
    if (!reason || !reason.trim()) return;
    setBusyId(id);
    try {
      await adminApi.orders.cancel(id, reason.trim());
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 text-xs font-semibold text-slate-500 hover:text-slate-700"
      >
        ← Back to all restaurants
      </button>
      <h2 className="mb-2 text-base font-semibold text-slate-900">{restaurant.name}</h2>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-400">
            <th className="py-2">Order</th>
            <th>Customer</th>
            <th>Status</th>
            <th>Total</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {orders?.map((o) => (
            <Fragment key={o.id}>
              <tr
                className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                onClick={() => void toggleExpand(o.id)}
              >
                <td className="py-2">{o.orderNumber}</td>
                <td>{o.customerName}</td>
                <td>{o.status}</td>
                <td>{formatINR(BigInt(o.payableTotalMinor))}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  {CANCELLABLE.has(o.status) && (
                    <button
                      type="button"
                      disabled={busyId === o.id}
                      onClick={() => void handleCancel(o.id)}
                      className="text-red-600 underline disabled:cursor-not-allowed"
                    >
                      Cancel
                    </button>
                  )}
                </td>
              </tr>
              {expandedId === o.id && (
                <tr className="border-b border-slate-100 bg-slate-50">
                  <td colSpan={5} className="p-3">
                    {detailError && <p className="text-sm text-red-600">{detailError}</p>}
                    {!detail && !detailError && <p className="text-sm text-slate-500">Loading…</p>}
                    {detail && detail.id === o.id && (
                      <div className="flex flex-col gap-3">
                        <div>
                          <p className="text-sm text-slate-800">{detail.customerPhone}</p>
                        </div>
                        <ul className="flex flex-col gap-1 text-sm">
                          {detail.items.map((item) => (
                            <li key={item.id} className="flex items-center justify-between">
                              <span>
                                {item.quantity}× {item.nameSnapshot}
                              </span>
                              <span className="font-mono">
                                {formatINR(BigInt(item.lineTotalMinor))}
                              </span>
                            </li>
                          ))}
                        </ul>
                        {detail.payment && (
                          <p className="text-xs text-slate-500">
                            Payment: {detail.payment.status} ({detail.payment.method ?? '—'})
                          </p>
                        )}
                        {(detail.rejectionReason || detail.cancellationReason) && (
                          <p className="text-sm text-red-600">
                            Reason: {detail.rejectionReason || detail.cancellationReason}
                          </p>
                        )}
                        {/* Delivery visibility panel (Phase 23a work item 3) — an admin investigating a stuck order shouldn't need to go elsewhere for this. */}
                        {detail.delivery ? (
                          <div className="rounded-md border border-slate-200 bg-white p-3 text-sm">
                            <p className="font-medium text-slate-900">
                              Delivery:{' '}
                              {DELIVERY_STATUS_LABEL[detail.delivery.status] ?? detail.delivery.status}
                            </p>
                            {detail.delivery.courierName && (
                              <p className="mt-1 text-slate-700">
                                Courier: {detail.delivery.courierName}
                                {detail.delivery.courierPhone
                                  ? ` · ${detail.delivery.courierPhone}`
                                  : ''}
                              </p>
                            )}
                            {detail.delivery.failureReason && (
                              <p className="mt-1 font-medium text-red-600">
                                {detail.delivery.failureReason}
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-slate-400">No delivery dispatched yet.</p>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {orders !== null && orders.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">No orders match.</p>
      )}
    </div>
  );
}
