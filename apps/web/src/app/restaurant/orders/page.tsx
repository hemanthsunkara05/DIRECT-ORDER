'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { formatINR } from '@direct-order/money';
import {
  ApiError,
  restaurantOrdersApi,
  type RestaurantOrderDetail,
  type RestaurantOrderSummary,
} from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';

/** The actionable queue (docs/04-api-specification.md §8.5) — not a full historical ledger; a restaurant reviewing past DELIVERED/REJECTED/CANCELLED orders is a reporting concern for a later phase. OUT_FOR_DELIVERY stays in the queue (Phase 11) — still active, and a DELIVERY_FAILED alert needs somewhere for staff to see it. */
const QUEUE_STATUSES = ['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY'];
const POLL_INTERVAL_MS = 15_000; // docs/04 §8.5: "If the stream is unavailable the dashboard falls back to polling every 15s"

const STATUS_LABEL: Record<string, string> = {
  PLACED: 'New',
  ACCEPTED: 'Accepted',
  PREPARING: 'Preparing',
  READY_FOR_PICKUP: 'Ready for pickup',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
};

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

export default function OrdersPage() {
  return (
    <ProtectedRoute>
      <OrderDashboard />
    </ProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

/** A short, dependency-free beep via the Web Audio API — no audio asset file exists in this codebase yet, and RISK-6 (docs/15-ambiguities-and-risks.md) explicitly calls for "an audible indicator". */
function playAlertTone(): void {
  try {
    const AudioContextClass =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 880;
    gain.gain.value = 0.15;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + 0.25);
    oscillator.onended = () => void ctx.close();
  } catch {
    // Audio is a nice-to-have alert, never a hard requirement — a
    // browser that blocks autoplay-without-interaction just stays silent.
  }
}

/**
 * SSE is a latency optimisation, never the source of truth (docs/04
 * §8.5) — this hook's only job on receiving an event is to trigger a
 * refetch of the real queue from the server, never to apply the
 * event's payload to local state directly. Skipped entirely for a
 * staff member belonging to more than one restaurant: `EventSource`
 * cannot set the `X-Restaurant-Id` header `AuthorizationGuard` needs to
 * disambiguate, so those accounts rely on the 15s poll alone (see
 * `restaurantOrdersApi.streamUrl`'s own doc comment for why this
 * wasn't solved by touching the guard instead). Native `EventSource`
 * reconnection (browser-managed, sends `Last-Event-ID` automatically)
 * is relied on directly rather than hand-rolled — simpler and no less
 * correct for a single, page-lifetime connection.
 */
function useOrderStream(enabled: boolean, onEvent: () => void): 'connecting' | 'open' | 'off' {
  const [status, setStatus] = useState<'connecting' | 'open' | 'off'>('off');
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      return;
    }
    setStatus('connecting');
    const source = new EventSource(restaurantOrdersApi.streamUrl(undefined), {
      withCredentials: true,
    });
    source.onopen = () => setStatus('open');
    source.onmessage = () => onEventRef.current();
    source.onerror = () => setStatus('connecting'); // browser retries automatically
    return () => source.close();
  }, [enabled]);

  return status;
}

function OrderDashboard() {
  const { user } = useSession();
  const membership = user?.restaurantMemberships[0];
  const restaurantId = membership?.restaurantId;
  const canUseSse = (user?.restaurantMemberships.length ?? 0) <= 1;

  const [orders, setOrders] = useState<RestaurantOrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RestaurantOrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const seenOrderIds = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    if (!restaurantId) return;
    try {
      const page = await restaurantOrdersApi.list({ status: QUEUE_STATUSES }, restaurantId);
      const newOrderIds = page.items.filter((o) => o.status === 'PLACED').map((o) => o.id);
      if (seenOrderIds.current === null) {
        // First load: everything already there is "known", not "new" —
        // only orders that appear on a LATER refresh should ever alert.
        seenOrderIds.current = new Set(newOrderIds);
      } else {
        const unseen = newOrderIds.filter((id) => !seenOrderIds.current!.has(id));
        if (unseen.length > 0) {
          playAlertTone();
          setAnnouncement(`${unseen.length} new order${unseen.length === 1 ? '' : 's'} placed.`);
        }
        for (const id of newOrderIds) seenOrderIds.current.add(id);
      }
      setOrders(page.items);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurantId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const streamStatus = useOrderStream(canUseSse && Boolean(restaurantId), () => void load());

  const loadDetail = useCallback(
    async (orderId: string) => {
      setSelectedId(orderId);
      setActionError(null);
      try {
        const d = await restaurantOrdersApi.detail(orderId, restaurantId);
        setDetail(d);
      } catch (err) {
        setActionError(formatError(err));
      }
    },
    [restaurantId],
  );

  async function runAction(action: () => Promise<{ status: string }>) {
    setBusy(true);
    setActionError(null);
    try {
      await action();
      await load();
      if (selectedId) await loadDetail(selectedId);
    } catch (err) {
      setActionError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleReject(orderId: string) {
    const reason = window.prompt(
      'Reason for rejecting this order (the customer will be refunded in full):',
    );
    if (!reason || !reason.trim()) return;
    await runAction(() => restaurantOrdersApi.reject(orderId, reason.trim(), restaurantId));
  }

  if (!restaurantId) {
    return <main className="p-6 text-sm text-slate-500">Loading…</main>;
  }

  return (
    <main className="mx-auto flex max-w-5xl gap-6 p-6">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <section className="flex-1">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Orders</h1>
          <p className="text-xs text-slate-400">
            {canUseSse ? (streamStatus === 'open' ? 'Live' : 'Connecting…') : 'Polling every 15s'}
          </p>
        </div>

        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}
        {orders !== null && orders.length === 0 && (
          <p className="text-sm text-slate-500">No active orders right now.</p>
        )}

        <ul className="flex flex-col gap-2">
          {orders?.map((order) => (
            <li key={order.id}>
              <button
                type="button"
                onClick={() => void loadDetail(order.id)}
                className={`flex w-full items-center justify-between rounded-lg border p-3 text-left ${
                  selectedId === order.id ? 'border-slate-900' : 'border-slate-200'
                } ${order.status === 'PLACED' ? 'bg-amber-50' : ''}`}
              >
                <div>
                  <p className="text-sm font-medium">{order.orderNumber}</p>
                  <p className="text-xs text-slate-500">{order.customerName}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs font-medium">
                    {STATUS_LABEL[order.status] ?? order.status}
                  </p>
                  <p className="text-sm">{formatINR(BigInt(order.payableTotalMinor))}</p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="w-96 shrink-0 rounded-lg border border-slate-200 p-4">
        {!detail && <p className="text-sm text-slate-500">Select an order to see details.</p>}
        {detail && (
          <div className="flex flex-col gap-3">
            <div>
              <p className="text-xs text-slate-400">Order</p>
              <h2 className="text-lg font-semibold">{detail.orderNumber}</h2>
              <p className="text-sm font-medium">{STATUS_LABEL[detail.status] ?? detail.status}</p>
            </div>

            <div>
              <p className="text-sm">{detail.customerName}</p>
              <p className="text-sm text-slate-500">{detail.customerPhone}</p>
            </div>

            <ul className="flex flex-col gap-1 text-sm">
              {detail.items.map((item) => (
                <li key={item.id} className="flex items-center justify-between">
                  <span>
                    {item.quantity}× {item.nameSnapshot}
                  </span>
                  <span>{formatINR(BigInt(item.lineTotalMinor))}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-slate-100 pt-2 text-sm font-semibold">
              <span>Total</span>
              <span>{formatINR(BigInt(detail.payableTotalMinor))}</span>
            </div>

            {detail.delivery && (
              <div className="rounded-md border border-slate-100 bg-slate-50 p-3 text-sm">
                <p className="font-medium">
                  Delivery:{' '}
                  {DELIVERY_STATUS_LABEL[detail.delivery.status] ?? detail.delivery.status}
                </p>
                {detail.delivery.provider === 'mock_delivery' && (
                  <p className="mt-1 text-xs text-amber-700">
                    Mock delivery provider — not production-enabled.
                  </p>
                )}
                {detail.delivery.courierName && (
                  <p className="mt-1 text-slate-600">
                    Courier: {detail.delivery.courierName}
                    {detail.delivery.courierPhone ? ` · ${detail.delivery.courierPhone}` : ''}
                  </p>
                )}
                {detail.delivery.failureReason && (
                  <p className="mt-1 text-red-700">{detail.delivery.failureReason}</p>
                )}
              </div>
            )}

            {actionError && <p className="text-sm text-red-600">{actionError}</p>}

            <div className="flex flex-col gap-2">
              {detail.status === 'PLACED' && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runAction(() => restaurantOrdersApi.accept(detail.id, restaurantId))
                    }
                    className="btn-primary disabled:cursor-not-allowed"
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleReject(detail.id)}
                    className="rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-700 disabled:cursor-not-allowed"
                  >
                    Reject (refunds in full)
                  </button>
                </>
              )}
              {detail.status === 'ACCEPTED' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(() => restaurantOrdersApi.preparing(detail.id, restaurantId))
                  }
                  className="btn-primary disabled:cursor-not-allowed"
                >
                  Start preparing
                </button>
              )}
              {detail.status === 'PREPARING' && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void runAction(() => restaurantOrdersApi.ready(detail.id, restaurantId))
                  }
                  className="btn-primary disabled:cursor-not-allowed"
                >
                  Mark ready for pickup
                </button>
              )}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
