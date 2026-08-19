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
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusPill, ORDER_STATUS_TONE, statusLabel } from '@/components/ui/StatusPill';
import { ReasonModal } from '@/components/ui/ReasonModal';

/**
 * Active orders plus recently-decided REJECTED/CANCELLED ones — a
 * restaurant needs to see "what did I just reject" without it vanishing
 * the instant the decision is made (docs feedback). Still not a full
 * historical ledger: DELIVERED is deliberately left out, and the list is
 * additionally scoped to TODAY only (`today: true` on the list call,
 * docs feedback: "current orders or that particular day orders only" —
 * older days belong in Order history's date-range export, not this
 * live queue). OUT_FOR_DELIVERY stays in — still active, and a
 * DELIVERY_FAILED alert needs somewhere for staff to see it.
 */
const VISIBLE_STATUSES = [
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'OUT_FOR_DELIVERY',
  'REJECTED',
  'CANCELLED',
];
const POLL_INTERVAL_MS = 15_000; // docs/04 §8.5: "If the stream is unavailable the dashboard falls back to polling every 15s"

const STATUS_LABEL: Record<string, string> = {
  PLACED: 'New',
  ACCEPTED: 'Accepted',
  PREPARING: 'Preparing',
  READY_FOR_PICKUP: 'Ready for pickup',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  REJECTED: 'Rejected',
  CANCELLED: 'Cancelled',
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
  // Which order's card is expanded inline (docs feedback: "show order
  // details like a dropdown from that particular order itself" — not a
  // separate side panel).
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RestaurantOrderDetail | null>(null);
  // Per-order, not a single global flag — actions now live inline on
  // every order's own box (docs feedback: "everything on the same order
  // box itself"), so more than one order's controls are on screen and
  // in-flight state must be tracked per order id, not for "the" action.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const seenOrderIds = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    if (!restaurantId) return;
    try {
      const page = await restaurantOrdersApi.list(
        { status: VISIBLE_STATUSES, today: true },
        restaurantId,
      );
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

  async function toggleExpand(orderId: string) {
    if (expandedId === orderId) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(orderId);
    setDetail(null);
    await loadDetail(orderId);
  }

  async function runOrderAction(orderId: string, action: () => Promise<{ status: string }>) {
    setBusyId(orderId);
    setActionError(null);
    try {
      await action();
      await load();
      if (expandedId === orderId) await loadDetail(orderId);
    } catch (err) {
      setActionError(formatError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(orderId: string, reason: string) {
    await runOrderAction(orderId, () => restaurantOrdersApi.reject(orderId, reason, restaurantId));
    setRejectingId(null);
  }

  async function handleCancel(orderId: string, reason: string) {
    await runOrderAction(orderId, () => restaurantOrdersApi.cancel(orderId, reason, restaurantId));
    setCancellingId(null);
  }

  if (!restaurantId) {
    return <main className="p-6 text-sm text-ink-500">Loading…</main>;
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

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
        {orders?.map((order, index) => {
          const isExpanded = expandedId === order.id;
          // Backend returns newest-first (`createdAt desc`) — today's
          // FIRST order (oldest) should read as #1, counting up through
          // the day (docs feedback), so this is the list length minus
          // position, not the raw index.
          const dailyOrderNumber = orders.length - index;
          return (
            <li
              key={order.id}
              className={`rounded-card border shadow-1 ${
                isExpanded ? 'border-ink-900' : 'border-ink-200'
              } ${order.status === 'PLACED' ? 'bg-warn-100' : 'bg-surface'}`}
            >
              <button
                type="button"
                onClick={() => void toggleExpand(order.id)}
                aria-expanded={isExpanded}
                className="flex w-full items-center justify-between p-3 text-left"
              >
                <div className="flex min-w-0 items-start gap-2.5">
                  <span
                    className="mt-0.5 shrink-0 font-mono text-sm font-semibold text-ink-400"
                    aria-hidden="true"
                  >
                    {dailyOrderNumber}.
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-900">{order.orderNumber}</p>
                    {/* Queue preview (docs feedback: "better to show the items of order rather than name of customer") */}
                    <p className="truncate text-xs text-ink-500">
                      {order.items.map((item) => `${item.quantity}× ${item.name}`).join(', ')}
                    </p>
                  </div>
                </div>
                <div className="ml-3 shrink-0 text-right">
                  <StatusPill
                    label={STATUS_LABEL[order.status] ?? statusLabel(order.status)}
                    tone={ORDER_STATUS_TONE[order.status] ?? 'ink'}
                  />
                  <p className="mt-1 font-mono text-sm text-ink-800">
                    {formatINR(BigInt(order.payableTotalMinor))}
                  </p>
                </div>
              </button>

              <OrderActions
                order={order}
                busy={busyId === order.id}
                onAccept={() =>
                  void runOrderAction(order.id, () =>
                    restaurantOrdersApi.accept(order.id, restaurantId),
                  )
                }
                onReject={() => setRejectingId(order.id)}
                onPreparing={() =>
                  void runOrderAction(order.id, () =>
                    restaurantOrdersApi.preparing(order.id, restaurantId),
                  )
                }
                onReady={() =>
                  void runOrderAction(order.id, () =>
                    restaurantOrdersApi.ready(order.id, restaurantId),
                  )
                }
                onCancel={() => setCancellingId(order.id)}
              />

              {/* Inline accordion detail (docs feedback: "click on order which will then show
                  the order details like a dropdown from that particular order itself") */}
              {isExpanded && (
                <div className="border-t border-dashed border-ink-200 p-3">
                  {!detail && <p className="text-sm text-ink-500">Loading…</p>}
                  {detail && detail.id === order.id && (
                    <div className="flex flex-col gap-3">
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
                            <span className="font-mono">
                              {formatINR(BigInt(item.lineTotalMinor))}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <div className="flex items-center justify-between border-t border-ink-200 pt-2 text-sm font-semibold text-ink-900">
                        <span>Total</span>
                        <span className="font-mono">
                          {formatINR(BigInt(detail.payableTotalMinor))}
                        </span>
                      </div>

                      {detail.delivery && (
                        <div className="rounded-ctrl border border-ink-200 bg-ink-100 p-3 text-sm">
                          <p className="font-medium text-ink-900">
                            Delivery:{' '}
                            {DELIVERY_STATUS_LABEL[detail.delivery.status] ??
                              detail.delivery.status}
                          </p>
                          {detail.delivery.provider === 'mock_delivery' && (
                            <p className="mt-1 text-xs text-warn-700">
                              Mock delivery provider — not production-enabled.
                            </p>
                          )}
                          {detail.delivery.courierName && (
                            <p className="mt-1 text-ink-700">
                              Courier: {detail.delivery.courierName}
                              {detail.delivery.courierPhone
                                ? ` · ${detail.delivery.courierPhone}`
                                : ''}
                            </p>
                          )}
                          {detail.delivery.failureReason && (
                            <p className="mt-1 font-medium text-error">
                              {detail.delivery.failureReason}
                            </p>
                          )}
                        </div>
                      )}

                      {(detail.rejectionReason || detail.cancellationReason) && (
                        <p className="text-sm text-error">
                          Reason: {detail.rejectionReason || detail.cancellationReason}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {actionError && <p className="mt-4 text-sm font-medium text-error">{actionError}</p>}

      {rejectingId && (
        <ReasonModal
          title="Reject order"
          consequence="The customer will be refunded in full and notified their order was rejected."
          confirmLabel="Reject order"
          confirmTone="error"
          onConfirm={(reason) => handleReject(rejectingId, reason)}
          onCancel={() => setRejectingId(null)}
        />
      )}

      {cancellingId && (
        <ReasonModal
          title="Cancel order"
          consequence="The customer will be refunded in full and notified their order was cancelled. This cannot be undone."
          confirmLabel="Cancel order"
          confirmTone="error"
          onConfirm={(reason) => handleCancel(cancellingId, reason)}
          onCancel={() => setCancellingId(null)}
        />
      )}
    </main>
  );
}

/**
 * Per-order inline action row (docs feedback: "everything on the same
 * order box itself") — the exact next action(s) for this order's current
 * status, matching the state machine's legal edges from
 * RestaurantOrderController. Cancel appears alongside the progression
 * action from ACCEPTED through READY_FOR_PICKUP (docs/06 BR-174) — full
 * refund, reason required; differential cancellation charges are
 * deferred, not this component's concern.
 */
function OrderActions({
  order,
  busy,
  onAccept,
  onReject,
  onPreparing,
  onReady,
  onCancel,
}: {
  order: RestaurantOrderSummary;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
  onPreparing: () => void;
  onReady: () => void;
  onCancel: () => void;
}) {
  const progressLabel =
    order.status === 'ACCEPTED'
      ? 'Start preparing'
      : order.status === 'PREPARING'
        ? 'Mark ready for pickup'
        : null;
  const progressAction = order.status === 'ACCEPTED' ? onPreparing : onReady;

  if (order.status !== 'PLACED' && !progressLabel && order.status !== 'READY_FOR_PICKUP') {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 border-t border-dashed border-ink-200 px-3 py-2">
      {order.status === 'PLACED' && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={onAccept}
            className="rounded-ctrl bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Accept
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onReject}
            className="rounded-ctrl bg-error px-3 py-1.5 text-xs font-semibold text-white hover:bg-error-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reject
          </button>
        </>
      )}
      {progressLabel && (
        <button
          type="button"
          disabled={busy}
          onClick={progressAction}
          className="rounded-ctrl bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {progressLabel}
        </button>
      )}
      {(order.status === 'ACCEPTED' ||
        order.status === 'PREPARING' ||
        order.status === 'READY_FOR_PICKUP') && (
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="rounded-ctrl border border-error px-3 py-1.5 text-xs font-semibold text-error hover:bg-error-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
