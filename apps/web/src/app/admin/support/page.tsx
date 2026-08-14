'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AdminGuard } from '@/lib/auth/admin-guard';
import { ApiError, adminApi, type AdminSupportCase } from '@/lib/api-client';
import { AdminNav } from '../admin-nav';

const STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_RESTAURANT', 'WAITING_PROVIDER', 'RESOLVED', 'CLOSED'];

export default function AdminSupportPage() {
  return (
    <AdminGuard>
      <SupportQueue />
    </AdminGuard>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

function SupportQueue() {
  const [cases, setCases] = useState<AdminSupportCase[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const page = await adminApi.support.list({ status: statusFilter || undefined });
      setCases(page.items);
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-2 text-xl font-semibold">Support</h1>
      <AdminNav />

      <select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
        className="mb-3 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
      >
        <option value="">All statuses</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-400">
            <th className="py-2">Case</th>
            <th>Subject</th>
            <th>Category</th>
            <th>Status</th>
            <th>Reporter</th>
            <th>Opened</th>
          </tr>
        </thead>
        <tbody>
          {cases?.map((c) => (
            <tr key={c.id} className="border-b border-slate-100">
              <td className="py-2">
                <Link href={`/admin/support/${c.id}`} className="text-indigo-600 underline">
                  {c.caseNumber}
                </Link>
              </td>
              <td>{c.subject}</td>
              <td>{c.category}</td>
              <td>{c.status}</td>
              <td>{c.customerId ? 'Customer' : 'Restaurant'}</td>
              <td>{new Date(c.createdAt).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {cases !== null && cases.length === 0 && <p className="mt-4 text-sm text-slate-500">No cases match.</p>}
    </main>
  );
}
