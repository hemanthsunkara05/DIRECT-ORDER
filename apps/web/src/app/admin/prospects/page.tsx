'use client';

// touch: force a fresh fs event for the dev-server file watcher.
import { useCallback, useEffect, useState } from 'react';
import { AdminGuard } from '@/lib/auth/admin-guard';
import { ApiError, adminApi, type UnclaimedListing } from '@/lib/api-client';
import { AdminNav } from '../admin-nav';

export default function AdminProspectsPage() {
  return (
    <AdminGuard>
      <ProspectsDashboard />
    </AdminGuard>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

function claimUrl(slug: string): string {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return `${origin}/signup?claim=${encodeURIComponent(slug)}`;
}

function outreachMessage(listing: UnclaimedListing): string {
  return (
    `Hi, this is Direct-Order — a commission-free ordering platform for ` +
    `${listing.city ?? 'local'} restaurants. We've set up a free preview listing for ` +
    `${listing.name}. If you'd like to claim it and start taking orders directly ` +
    `(no commission), set up your account here: ${claimUrl(listing.slug)}`
  );
}

function ProspectsDashboard() {
  const [listings, setListings] = useState<UnclaimedListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setListings(await adminApi.restaurants.unclaimed());
      setError(null);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCopy(listing: UnclaimedListing, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSlug(listing.slug);
      setTimeout(() => setCopiedSlug((current) => (current === listing.slug ? null : current)), 2000);
    } catch {
      // Clipboard permission denied or unavailable — the link/message is
      // still visible on the row to copy by hand.
    }
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="mb-2 text-xl font-semibold">Prospects</h1>
      <p className="mb-2 text-sm text-slate-500">
        Preview listings not yet claimed by a real owner. Each one has a claim link — send it via
        WhatsApp, SMS, or a call — and the restaurant becomes real the moment they sign up and
        finish onboarding through it. Nothing here is live or orderable until then.
      </p>
      <AdminNav />

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-400">
            <th className="py-2">Name</th>
            <th>City</th>
            <th>Phone</th>
            <th>Claim link</th>
            <th>Outreach message</th>
          </tr>
        </thead>
        <tbody>
          {listings?.map((listing) => (
            <tr key={listing.slug} className="border-b border-slate-100 align-top">
              <td className="py-2 pr-3">
                <a
                  href={`/r/${listing.slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-600 underline"
                >
                  {listing.name}
                </a>
              </td>
              <td className="pr-3">{listing.city ?? '—'}</td>
              <td className="pr-3">{listing.phone ?? '—'}</td>
              <td className="pr-3">
                <button
                  type="button"
                  onClick={() => void handleCopy(listing, claimUrl(listing.slug))}
                  className="text-indigo-600 underline"
                >
                  {copiedSlug === listing.slug ? 'Copied' : 'Copy link'}
                </button>
              </td>
              <td className="py-2">
                <button
                  type="button"
                  onClick={() => void handleCopy(listing, outreachMessage(listing))}
                  className="text-indigo-600 underline"
                >
                  Copy message
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {listings !== null && listings.length === 0 && (
        <p className="mt-4 text-sm text-slate-500">No unclaimed listings.</p>
      )}
    </main>
  );
}
