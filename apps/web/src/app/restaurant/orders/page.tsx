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
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusPill, ORDER_STATUS_TONE, statusLabel } from '@/components/ui/StatusPill';
import { ReasonModal } from '@/components/ui/ReasonModal';

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
  const { user, activeRestaurantId } = useSession();
  const restaurantId = activeRestaurantId ?? undefined;
  // SSE has no way to carry the X-Restaurant-Id header EventSource
  // can't set — this is about how many restaurants exist to
  // disambiguate between, independent of which one is currently
  // active in the switcher, so it stays keyed off membership count.
  const canUseSse = (user?.restaurantMemberships.length ?? 0) <= 1;

  const [orders, setOrders] = useState<RestaurantOrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RestaurantOrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [rejecting, setRejecting] = useState(false);
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

  async function handleReject(orderId: string, reason: string) {
    await runAction(() => restaurantOrdersApi.reject(orderId, reason, restaurantId));
    setRejecting(false);
  }

  if (!restaurantId) {
    return <main className="p-6 text-sm text-ink-500">Loading…</main>;
  }

  return (
    <main className="mx-auto flex max-w-5xl gap-6 p-6">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <section className="flex-1">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-ink-900">Orders</h1>
          <p className="font-mono text-xs text-ink-400">
            {canUseSse ? (streamStatus === 'open' ? 'Live' : 'Connecting…') : 'Polling every 15s'}
          </p>
        </div>

        {error && <p className="mb-4 text-sm font-medium text-error">{error}</p>}
        {orders !== null && orders.length === 0 && (
          <EmptyState message="No active orders right now." />
        )}

        <ul className="flex flex-col gap-2">
          {orders?.map((order) => (
            <li key={order.id}>
              <button
                type="button"
                onClick={() => void loadDetail(order.id)}
                className={`flex w-full items-center justify-between rounded-card border p-3 text-left shadow-1 ${
                  selectedId === order.id ? 'border-ink-900' : 'border-ink-200'
                } ${order.status === 'PLACED' ? 'bg-warn-100' : 'bg-surface'}`}
              >
                <div>
                  <p className="text-sm font-medium text-ink-900">{order.orderNumber}</p>
                  <p className="text-xs text-ink-500">{order.customerName}</p>
                </div>
                <div className="text-right">
                  <StatusPill
                    label={STATUS_LABEL[order.status] ?? statusLabel(order.status)}
                    tone={ORDER_STATUS_TONE[order.status] ?? 'ink'}
                  />
                  <p className="mt-1 font-mono text-sm text-ink-800">
                    {formatINR(BigInt(order.payableTotalMinor))}
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="w-96 shrink-0 rounded-card border border-ink-200 bg-surface p-[22px] shadow-1">
        {!detail && <p className="text-sm text-ink-500">Select an order to see details.</p>}
        {detail && (
          <div className="flex flex-col gap-3">
            <div>
              <p className="font-mono text-xs text-ink-400">Order</p>
              <h2 className="font-mono text-lg font-bold text-ink-900">{detail.orderNumber}</h2>
              <StatusPill
                label={STATUS_LABEL[detail.status] ?? statusLabel(detail.status)}
                tone={ORDER_STATUS_TONE[detail.status] ?? 'ink'}
              />
            </div>

            <div>
              <p className="text-sm text-ink-800">{detail.customerName}</p>
              <p className="text-sm text-ink-500">{detail.customerPhone}</p>
            </div>

            <ul className="flex flex-col gap-1 text-sm">
              {detail.items.map((item) => (
                <li key={item.id} className="flex items-center justify-between text-ink-800">
                  <span>
                    {item.quantity}× {item.nameSnapshot}
                  </span>
                  <span className="font-mono">{formatINR(BigInt(item.lineTotalMinor))}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-ink-200 pt-2 text-sm font-semibold text-ink-900">
              <span>Total</span>
              <span className="font-mono">{formatINR(BigInt(detail.payableTotalMinor))}</span>
            </div>

            {detail.delivery && (
              <div className="rounded-ctrl border border-ink-200 bg-ink-100 p-3 text-sm">
                <p className="font-medium text-ink-900">
                  Delivery:{' '}
                  {DELIVERY_STATUS_LABEL[detail.delivery.status] ?? detail.delivery.status}
                </p>
                {detail.delivery.provider === 'mock_delivery' && (
                  <p className="mt-1 text-xs text-warn-700">
                    Mock delivery provider — not production-enabled.
                  </p>
                )}
                {detail.delivery.courierName && (
                  <p className="mt-1 text-ink-700">
                    Courier: {detail.delivery.courierName}
                    {detail.delivery.courierPhone ? ` · ${detail.delivery.courierPhone}` : ''}
                  </p>
                )}
                {detail.delivery.failureReason && (
                  <p className="mt-1 font-medium text-error">{detail.delivery.failureReason}</p>
                )}
              </div>
            )}

            {actionError && <p className="text-sm font-medium text-error">{actionError}</p>}

            <div className="flex flex-col gap-2">
              {detail.status === 'PLACED' && (
                <>
                  <Button
                    disabled={busy}
                    loading={busy}
                    onClick={() =>
                      void runAction(() => restaurantOrdersApi.accept(detail.id, restaurantId))
                    }
                  >
                    Accept
                  </Button>
                  <Button variant="destructive" disabled={busy} onClick={() => setRejecting(true)}>
                    Reject (refunds in full)
                  </Button>
                </>
              )}
              {detail.status === 'ACCEPTED' && (
                <Button
                  disabled={busy}
                  loading={busy}
                  onClick={() =>
                    void runAction(() => restaurantOrdersApi.preparing(detail.id, restaurantId))
                  }
                >
                  Start preparing
                </Button>
              )}
              {detail.status === 'PREPARING' && (
                <Button
                  disabled={busy}
                  loading={busy}
                  onClick={() =>
                    void runAction(() => restaurantOrdersApi.ready(detail.id, restaurantId))
                  }
                >
                  Mark ready for pickup
                </Button>
              )}
            </div>
          </div>
        )}
      </section>

      {rejecting && detail && (
        <ReasonModal
          title="Reject order"
          consequence="The customer will be refunded in full and notified their order was rejected."
          confirmLabel="Reject order"
          confirmTone="error"
          onConfirm={(reason) => handleReject(detail.id, reason)}
          onCancel={() => setRejecting(false)}
        />
      )}
    </main>
  );
}
