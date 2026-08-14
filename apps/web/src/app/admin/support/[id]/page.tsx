'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminGuard } from '@/lib/auth/admin-guard';
import {
  ApiError,
  adminApi,
  type AdminSupportCase,
  type AdminSupportMessage,
} from '@/lib/api-client';
import { AdminNav } from '../../admin-nav';

export default function AdminSupportCaseDetailPage() {
  return (
    <AdminGuard>
      <CaseDetail />
    </AdminGuard>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

const CLOSED_STATUSES = new Set(['CLOSED']);

function CaseDetail() {
  const params = useParams<{ id: string }>();
  const [detail, setDetail] = useState<(AdminSupportCase & { messages: AdminSupportMessage[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await adminApi.support.get(params.id));
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, [params.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (detail === null) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <AdminNav />
        {error ? <p className="text-sm text-red-600">{error}</p> : <p className="text-sm text-slate-500">Loading…</p>}
      </main>
    );
  }

  const closed = CLOSED_STATUSES.has(detail.status);

  return (
    <main className="mx-auto max-w-2xl p-6">
      <AdminNav />
      <Link href="/admin/support" className="text-xs text-slate-400 hover:underline">
        ← Back to queue
      </Link>

      <div className="mt-2">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">{detail.subject}</h1>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{detail.status}</span>
        </div>
        <p className="text-xs text-slate-400">
          {detail.caseNumber} · {detail.category} · {detail.priority} · {detail.customerId ? 'Customer' : 'Restaurant'}-reported
        </p>
        <p className="mt-2 text-sm text-slate-700">{detail.description}</p>
        {detail.assignedToUserId && (
          <p className="mt-1 text-xs text-slate-400">Assigned to {detail.assignedToUserId}</p>
        )}
        {detail.resolutionNote && (
          <p className="mt-1 text-xs text-slate-500">Resolution: {detail.resolutionNote}</p>
        )}
      </div>

      <AssignForm caseId={detail.id} onAssigned={load} />

      <section className="mt-6 flex flex-col gap-3">
        {detail.messages.map((m) => (
          <div
            key={m.id}
            className={`rounded-lg border p-3 text-sm ${m.visibility === 'INTERNAL' ? 'border-amber-300 bg-amber-50' : 'border-slate-200'}`}
          >
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-slate-500">{m.authorType}</p>
              <span
                className={`rounded px-1.5 py-0.5 text-xs ${m.visibility === 'INTERNAL' ? 'bg-amber-200 text-amber-800' : 'bg-emerald-100 text-emerald-700'}`}
              >
                {m.visibility}
              </span>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-slate-800">{m.body}</p>
            <p className="mt-1 text-xs text-slate-400">{new Date(m.createdAt).toLocaleString()}</p>
          </div>
        ))}
        {detail.messages.length === 0 && <p className="text-sm text-slate-500">No messages yet.</p>}
      </section>

      {closed ? (
        <p className="mt-4 text-sm text-slate-500">This case is closed.</p>
      ) : (
        <>
          <ReplyForm caseId={detail.id} onSent={load} />
          <ResolveForm caseId={detail.id} onResolved={load} />
        </>
      )}
    </main>
  );
}

function AssignForm({ caseId, onAssigned }: { caseId: string; onAssigned: () => Promise<void> }) {
  const [assignedToUserId, setAssignedToUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await adminApi.support.assign(caseId, assignedToUserId.trim());
      setAssignedToUserId('');
      await onAssigned();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 flex items-end gap-2 rounded-lg border border-slate-200 p-3">
      <div className="flex-1">
        <label className="text-xs text-slate-500">Assign to (admin user id)</label>
        <input
          required
          value={assignedToUserId}
          onChange={(e) => setAssignedToUserId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          className="input"
        />
      </div>
      <button type="submit" disabled={saving} className="btn-secondary">
        {saving ? 'Assigning…' : 'Assign'}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </form>
  );
}

function ReplyForm({ caseId, onSent }: { caseId: string; onSent: () => Promise<void> }) {
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'PUBLIC' | 'INTERNAL'>('PUBLIC');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      await adminApi.support.reply(caseId, body.trim(), visibility);
      setBody('');
      await onSent();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 flex flex-col gap-2 rounded-lg border border-slate-200 p-4">
      <textarea
        required
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={5000}
        placeholder="Write a reply…"
        className="input"
      />
      <div className="flex items-center gap-3 text-sm">
        <label className="flex items-center gap-1">
          <input type="radio" checked={visibility === 'PUBLIC'} onChange={() => setVisibility('PUBLIC')} />
          Public (visible to the reporter)
        </label>
        <label className="flex items-center gap-1">
          <input type="radio" checked={visibility === 'INTERNAL'} onChange={() => setVisibility('INTERNAL')} />
          Internal note
        </label>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <button type="submit" disabled={sending} className="btn-primary w-fit">
        {sending ? 'Sending…' : 'Send'}
      </button>
    </form>
  );
}

function ResolveForm({ caseId, onResolved }: { caseId: string; onResolved: () => Promise<void> }) {
  const [resolutionNote, setResolutionNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await adminApi.support.resolve(caseId, resolutionNote.trim());
      setOpen(false);
      setResolutionNote('');
      await onResolved();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-secondary mt-4">
        Resolve
      </button>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="mt-4 flex flex-col gap-2 rounded-lg border border-slate-200 p-4">
      <textarea
        required
        value={resolutionNote}
        onChange={(e) => setResolutionNote(e.target.value)}
        rows={2}
        maxLength={2000}
        placeholder="Resolution note…"
        className="input"
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="btn-primary w-fit">
          {saving ? 'Resolving…' : 'Mark resolved'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn-secondary w-fit">
          Cancel
        </button>
      </div>
    </form>
  );
}
