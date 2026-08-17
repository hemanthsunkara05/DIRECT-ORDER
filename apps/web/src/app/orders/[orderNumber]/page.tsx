'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { formatINR } from '@direct-order/money';
import Link from 'next/link';
import { ApiError, orderApi, type OrderTrackingView } from '@/lib/api-client';
import { ReviewForm } from './review-form';
import { Button } from '@/components/ui/Button';
import { OrderStatusTimeline } from '@/components/ui/OrderStatusTimeline';

const TIMELINE_STATUSES = new Set([
  'PLACED',
  'ACCEPTED',
  'PREPARING',
  'READY_FOR_PICKUP',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
]);

const STATUS_LABEL: Record<string, string> = {
  PENDING_PAYMENT: 'Awaiting payment',
  PLACED: 'Order placed',
  PAYMENT_FAILED: 'Payment failed',
  EXPIRED: 'Expired — payment was never completed',
  ACCEPTED: 'Accepted by the restaurant',
  PREPARING: 'Being prepared',
  READY_FOR_PICKUP: 'Ready for pickup',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  DELIVERY_FAILED: 'Delivery failed',
  REJECTED: 'Rejected by the restaurant',
  CANCELLED: 'Cancelled',
};

const DELIVERY_STATUS_LABEL: Record<string, string> = {
  PENDING_CREATION: 'Arranging delivery…',
  CREATED: 'Delivery arranged',
  CREATION_FAILED: 'Could not arrange delivery — the restaurant has been notified',
  SEARCHING_COURIER: 'Looking for a courier',
  COURIER_ASSIGNED: 'Courier assigned',
  AT_PICKUP: 'Courier is at the restaurant',
  PICKED_UP: 'Picked up by courier',
  NO_COURIER_FOUND: 'No courier available right now',
  DELIVERED: 'Delivered',
  CANCELLED: 'Delivery cancelled',
  FAILED: 'Delivery failed',
};

/**
 * `GET /public/orders/:orderNumber?token=` +
 * `POST /public/orders/:orderNumber/verify-payment` (docs/04-api-
 * specification.md §8.3). One page for payment, confirmation, and
 * ongoing tracking — the order's own `status` decides what's shown, so
 * refreshing this exact URL at any point (payment pending, just placed,
 * accepted, ...) always renders the right thing rather than needing
 * separate pages that could disagree with the server's state.
 */
export default function OrderTrackingPage() {
  const params = useParams<{ orderNumber: string }>();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [order, setOrder] = useState<OrderTrackingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [mockUnavailable, setMockUnavailable] = useState(false);

  const refresh = useCallback(async () => {
    if (!token) {
      setError(
        'This link is missing its access token — use the link from your order confirmation.',
      );
      return;
    }
    try {
      const view = await orderApi.track(params.orderNumber, token);
      setOrder(view);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Could not load this order.');
    }
  }, [params.orderNumber, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function simulate(outcome: 'CAPTURED' | 'FAILED') {
    if (!token) return;
    setPaying(true);
    setPayError(null);
    try {
      const { providerPaymentId } = await orderApi.simulatePayment(
        params.orderNumber,
        token,
        outcome,
      );
      await orderApi.verifyPayment(params.orderNumber, token, providerPaymentId ?? undefined);
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setMockUnavailable(true);
      } else {
        setPayError(err instanceof ApiError ? err.body.message : 'Could not process the payment.');
      }
    } finally {
      setPaying(false);
    }
  }

  if (error) {
    return <main className="mx-auto max-w-xl p-6 text-sm font-medium text-error">{error}</main>;
  }
  if (!order) {
    return <main className="mx-auto max-w-xl p-6 text-sm text-ink-500">Loading…</main>;
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-6" style={{ background: 'var(--bg)' }}>
      <div>
        <p className="font-mono text-xs text-ink-400">Order</p>
        <h1 className="font-mono text-xl font-bold text-ink-900">{order.orderNumber}</h1>
        <p className="mt-1 text-sm font-medium text-ink-700">
          {STATUS_LABEL[order.status] ?? order.status}
        </p>
      </div>

      {TIMELINE_STATUSES.has(order.status) && (
        <section className="rounded-card border border-ink-200 bg-surface p-[22px] shadow-1">
          <OrderStatusTimeline status={order.status} />
        </section>
      )}

      <p className="text-sm text-ink-500">
        Want to earn loyalty points and track your order history?{' '}
        <Link href="/customer/login" className="font-medium text-brand-600 underline">
          Create a free account
        </Link>
        .
      </p>

      {order.status === 'PENDING_PAYMENT' && (
        <section className="flex flex-col gap-3 rounded-card border border-warn bg-warn-100 p-[22px]">
          <p className="text-sm text-warn-700">
            Complete payment to place your order. This environment uses a mock payment provider for
            local development and testing — no real payment is processed.
          </p>
          {mockUnavailable && (
            <p className="text-sm text-ink-700">
              This environment is configured for a real payment provider; simulated payment
              isn&apos;t available here. Complete payment through the provider&apos;s checkout
              instead.
            </p>
          )}
          {!mockUnavailable && (
            <div className="flex gap-3">
              <Button disabled={paying} loading={paying} onClick={() => void simulate('CAPTURED')}>
                Simulate successful payment
              </Button>
              <Button variant="secondary" disabled={paying} onClick={() => void simulate('FAILED')}>
                Simulate failed payment
              </Button>
            </div>
          )}
          {payError && <p className="text-sm font-medium text-error">{payError}</p>}
        </section>
      )}

      {order.status === 'PAYMENT_FAILED' && (
        <section className="rounded-card border border-error bg-error-100 p-[22px]">
          <p className="text-sm text-error-700">
            Payment was not completed for this order. Please start a new order — retrying payment on
            this same order isn&apos;t available yet.
          </p>
        </section>
      )}

      <section className="rounded-card border border-ink-200 bg-surface p-[22px] shadow-1">
        <h2 className="mb-2 text-sm font-bold text-ink-900">Items</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {order.items.map((item, i) => (
            <li key={i} className="flex items-center justify-between text-ink-800">
              <span>
                {item.quantity}× {item.name}
              </span>
              <span className="font-mono">{formatINR(BigInt(item.lineTotalMinor))}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center justify-between border-t border-ink-200 pt-2 text-sm font-semibold text-ink-900">
          <span>Total</span>
          <span className="font-mono">{formatINR(BigInt(order.payableTotalMinor))}</span>
        </div>
      </section>

      <section className="rounded-card border border-ink-200 bg-surface p-[22px] shadow-1">
        <h2 className="mb-2 text-sm font-bold text-ink-900">Delivering to</h2>
        <p className="text-sm text-ink-700">{order.customerName}</p>
        <p className="text-sm text-ink-500">{formatAddress(order.deliveryAddress)}</p>
      </section>

      {order.delivery && (
        <section className="rounded-card border border-ink-200 bg-surface p-[22px] shadow-1">
          <h2 className="mb-2 text-sm font-bold text-ink-900">Delivery</h2>
          <p className="text-sm text-ink-700">
            {DELIVERY_STATUS_LABEL[order.delivery.status] ?? order.delivery.status}
          </p>
          {order.delivery.courierName && (
            <p className="mt-1 text-sm text-ink-500">
              Courier: {order.delivery.courierName}
              {order.delivery.courierPhone ? ` · ${order.delivery.courierPhone}` : ''}
            </p>
          )}
          {order.delivery.trackingUrl && (
            <a
              href={order.delivery.trackingUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-block text-sm font-medium text-brand-600 underline"
            >
              Track delivery
            </a>
          )}
        </section>
      )}

      {order.status === 'DELIVERED' && token && (
        <ReviewForm orderNumber={order.orderNumber} token={token} />
      )}

      <section className="rounded-card border border-ink-200 bg-surface p-[22px] shadow-1">
        <h2 className="mb-2 text-sm font-bold text-ink-900">Status history</h2>
        <ol className="flex flex-col gap-1 text-sm">
          {order.history.map((entry, i) => (
            <li
              key={i}
              className="flex items-center justify-between border-t border-dashed border-ink-200 py-1.5 text-ink-700 first:border-t-0"
            >
              <span>{STATUS_LABEL[entry.toStatus] ?? entry.toStatus}</span>
              <span className="font-mono text-xs text-ink-400">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

function formatAddress(address: unknown): string {
  if (typeof address !== 'object' || address === null) return '';
  const a = address as { line1?: string; locality?: string; city?: string; postalCode?: string };
  return [a.line1, a.locality, a.city, a.postalCode].filter(Boolean).join(', ');
}
