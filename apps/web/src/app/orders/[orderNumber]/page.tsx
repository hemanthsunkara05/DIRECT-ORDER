'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { formatINR } from '@direct-order/money';
import { ApiError, orderApi, type OrderTrackingView } from '@/lib/api-client';

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
    return <main className="mx-auto max-w-xl p-6 text-sm text-red-600">{error}</main>;
  }
  if (!order) {
    return <main className="mx-auto max-w-xl p-6 text-sm text-slate-500">Loading…</main>;
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <div>
        <p className="text-xs text-slate-400">Order</p>
        <h1 className="text-xl font-semibold">{order.orderNumber}</h1>
        <p className="mt-1 text-sm font-medium text-slate-700">
          {STATUS_LABEL[order.status] ?? order.status}
        </p>
      </div>

      {order.status === 'PENDING_PAYMENT' && (
        <section className="flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm text-amber-900">
            Complete payment to place your order. This environment uses a mock payment provider for
            local development and testing — no real payment is processed.
          </p>
          {mockUnavailable && (
            <p className="text-sm text-slate-600">
              This environment is configured for a real payment provider; simulated payment
              isn&apos;t available here. Complete payment through the provider&apos;s checkout
              instead.
            </p>
          )}
          {!mockUnavailable && (
            <div className="flex gap-3">
              <button
                type="button"
                disabled={paying}
                onClick={() => void simulate('CAPTURED')}
                className="btn-primary disabled:cursor-not-allowed"
              >
                {paying ? 'Processing…' : 'Simulate successful payment'}
              </button>
              <button
                type="button"
                disabled={paying}
                onClick={() => void simulate('FAILED')}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 disabled:cursor-not-allowed"
              >
                Simulate failed payment
              </button>
            </div>
          )}
          {payError && <p className="text-sm text-red-600">{payError}</p>}
        </section>
      )}

      {order.status === 'PAYMENT_FAILED' && (
        <section className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-800">
            Payment was not completed for this order. Please start a new order — retrying payment on
            this same order isn&apos;t available yet.
          </p>
        </section>
      )}

      <section className="rounded-lg border border-slate-200 p-4">
        <h2 className="mb-2 text-sm font-semibold">Items</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {order.items.map((item, i) => (
            <li key={i} className="flex items-center justify-between">
              <span>
                {item.quantity}× {item.name}
              </span>
              <span>{formatINR(BigInt(item.lineTotalMinor))}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2 text-sm font-semibold">
          <span>Total</span>
          <span>{formatINR(BigInt(order.payableTotalMinor))}</span>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 p-4">
        <h2 className="mb-2 text-sm font-semibold">Delivering to</h2>
        <p className="text-sm text-slate-700">{order.customerName}</p>
        <p className="text-sm text-slate-500">{formatAddress(order.deliveryAddress)}</p>
      </section>

      <section className="rounded-lg border border-slate-200 p-4">
        <h2 className="mb-2 text-sm font-semibold">Status history</h2>
        <ol className="flex flex-col gap-1 text-sm text-slate-600">
          {order.history.map((entry, i) => (
            <li key={i} className="flex items-center justify-between">
              <span>{STATUS_LABEL[entry.toStatus] ?? entry.toStatus}</span>
              <span className="text-xs text-slate-400">
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
