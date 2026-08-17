'use client';

import { useCallback, useEffect, useState } from 'react';
import { AdminGuard } from '@/lib/auth/admin-guard';
import { ApiError, adminApi, type AuditLogEntry } from '@/lib/api-client';

export default function AdminAuditPage() {
  return (
    <AdminGuard>
      <AuditDashboard />
    </AdminGuard>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

function AuditDashboard() {
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await adminApi.auditLogs.list();
      setEntries(page.items);
      setError(null);
    } catch (err) {
      // SUPER_ADMIN-only (audit:read) — a non-SUPER_ADMIN admin sees a clear 403, not a blank page.
      setError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-2 text-xl font-semibold">Audit log</h1>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <ul className="flex flex-col gap-2">
        {entries?.map((entry) => (
          <li key={entry.id} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">{entry.action}</span>
              <span className="text-xs text-slate-400">
                {new Date(entry.createdAt).toLocaleString()}
              </span>
            </div>
            <p className="text-slate-600">
              {entry.actorType} {entry.actorId ? `(${entry.actorId})` : ''} → {entry.entityType}
              {entry.entityId ? ` ${entry.entityId}` : ''}
            </p>
            {entry.reason && <p className="text-slate-500">Reason: {entry.reason}</p>}
          </li>
        ))}
      </ul>
      {entries !== null && entries.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">No audit entries yet.</p>
      )}
    </main>
  );
}
