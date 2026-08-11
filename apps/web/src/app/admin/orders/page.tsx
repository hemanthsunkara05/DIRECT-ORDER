'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatINR } from '@direct-order/money';
import { AdminGuard } from '@/lib/auth/admin-guard';
import { ApiError, adminApi, type AdminOrderSummary } from '@/lib/api-client';
import { AdminNav } from '../admin-nav';

const CANCELLABLE = new Set(['PLACED', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']);

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

function OrdersDashboard() {
  const [orders, setOrders] = useState<AdminOrderSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const page = await adminApi.orders.list({ status: statusFilter || undefined });
      setOrders(page.items);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

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
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-2 text-xl font-semibold">Orders</h1>
      <AdminNav />

      <input
        type="text"
        placeholder="Filter by status (e.g. PLACED)"
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value.toUpperCase())}
        className="mb-3 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
      />

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
            <tr key={o.id} className="border-b border-slate-100">
              <td className="py-2">{o.orderNumber}</td>
              <td>{o.customerName}</td>
              <td>{o.status}</td>
              <td>{formatINR(BigInt(o.payableTotalMinor))}</td>
              <td>
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
          ))}
        </tbody>
      </table>
      {orders !== null && orders.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">No orders match.</p>
      )}
    </main>
  );
}
