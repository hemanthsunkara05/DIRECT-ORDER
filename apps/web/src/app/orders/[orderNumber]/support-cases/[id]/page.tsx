'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  ApiError,
  guestSupportApi,
  type SupportCaseSummary,
  type SupportMessageView,
} from '@/lib/api-client';
import { uploadGuestSupportAttachment } from '@/lib/support-attachment';

/**
 * Guest complaint thread view — same shape as `/customer/support/[id]`
 * (`CaseDetail`) but token-scoped instead of session-scoped, so a guest
 * who filed a complaint from `/orders/[orderNumber]` can come back to the
 * same tracking link and see replies without ever creating an account.
 */
export default function GuestSupportCaseDetailPage() {
  const params = useParams<{ orderNumber: string; id: string }>();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  const [detail, setDetail] = useState<(SupportCaseSummary & { messages: SupportMessageView[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    if (!token) {
      setError('This link is missing its access token — use the link from your order confirmation.');
      return;
    }
    try {
      setDetail(await guestSupportApi.get(params.orderNumber, token, params.id));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Could not load this report.');
    }
  }, [params.orderNumber, params.id, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleReply(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setSending(true);
    setError(null);
    try {
      const attachments = file
        ? [await uploadGuestSupportAttachment(params.orderNumber, token, params.id, file)]
        : undefined;
      await guestSupportApi.reply(params.orderNumber, token, params.id, body.trim(), attachments);
      setBody('');
      setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Could not send your reply.');
    } finally {
      setSending(false);
    }
  }

  if (detail === null) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-4 p-8">
        {error ? <p className="text-sm text-red-600">{error}</p> : <p className="text-sm text-slate-500">Loading…</p>}
      </main>
    );
  }

  const closed = detail.status === 'CLOSED';

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-6 p-8">
      <Link href={`/orders/${params.orderNumber}?token=${encodeURIComponent(token ?? '')}`} className="text-xs text-slate-400 hover:underline">
        ← Back to your order
      </Link>
      <div>
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">{detail.subject}</h1>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{detail.status}</span>
        </div>
        <p className="text-xs text-slate-400">
          {detail.caseNumber} · {detail.category}
        </p>
        <p className="mt-2 text-sm text-slate-700">{detail.description}</p>
      </div>

      <section className="flex flex-col gap-3">
        {detail.messages.map((m) => (
          <div key={m.id} className="rounded-lg border border-slate-200 p-3 text-sm">
            <p className="text-xs font-medium text-slate-500">
              {m.authorType === 'AGENT' ? 'Support' : m.authorType === 'CUSTOMER' ? 'You' : m.authorType}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-slate-800">{m.body}</p>
            <p className="mt-1 text-xs text-slate-400">{new Date(m.createdAt).toLocaleString()}</p>
          </div>
        ))}
        {detail.messages.length === 0 && <p className="text-sm text-slate-500">No replies yet.</p>}
      </section>

      {closed ? (
        <p className="text-sm text-slate-500">This case is closed.</p>
      ) : (
        <form onSubmit={(e) => void handleReply(e)} className="flex flex-col gap-2 rounded-lg border border-slate-200 p-4">
          <textarea
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={5000}
            placeholder="Write a reply…"
            className="input"
          />
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-xs"
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
          <button type="submit" disabled={sending} className="btn-primary w-fit">
            {sending ? 'Sending…' : 'Reply'}
          </button>
        </form>
      )}
    </main>
  );
}
