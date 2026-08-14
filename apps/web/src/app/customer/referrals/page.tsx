'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, loyaltyApi, type ReferralView } from '@/lib/api-client';
import { CustomerProtectedRoute } from '@/lib/auth/customer-protected-route';

export default function CustomerReferralsPage() {
  return (
    <CustomerProtectedRoute>
      <ReferralsView />
    </CustomerProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

const STATUS_LABELS: Record<ReferralView['status'], string> = {
  PENDING: 'Waiting for their first order',
  QUALIFIED: 'Qualified — reward on the way',
  REWARDED: 'Reward earned',
  EXPIRED: 'Expired',
  INVALIDATED: 'Invalidated (order refunded)',
};

/**
 * BR-115: this page renders exactly what `GET /me/referrals` returns —
 * status and timestamps only. There is deliberately no name/phone/email
 * column to add here even for a future redesign: the API response
 * itself never carries that data for a referred customer, by design.
 */
function ReferralsView() {
  const [code, setCode] = useState<string | null>(null);
  const [referrals, setReferrals] = useState<ReferralView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await loyaltyApi.referrals();
      setCode(res.code);
      setReferrals(res.referrals);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const link =
    code && typeof window !== 'undefined'
      ? `${window.location.origin}/customer/login?ref=${encodeURIComponent(code)}`
      : null;

  async function copyLink() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-6 p-8">
      <h1 className="text-xl font-semibold">Refer a friend</h1>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {code && (
        <section className="rounded-lg border border-slate-200 p-5">
          <p className="text-sm text-slate-500">Your referral code</p>
          <p className="mt-1 text-2xl font-bold tracking-wide">{code}</p>
          {link && (
            <div className="mt-4 flex flex-col gap-2">
              <input readOnly value={link} className="input text-xs" />
              <button type="button" onClick={() => void copyLink()} className="btn-secondary">
                {copied ? 'Copied!' : 'Copy link'}
              </button>
            </div>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-2 text-lg font-semibold">Your referrals</h2>
        {referrals === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : referrals.length === 0 ? (
          <p className="text-sm text-slate-500">
            No referrals yet — share your link above to get started.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-200 rounded-lg border border-slate-200">
            {referrals.map((r, i) => (
              <li key={i} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <p className="font-medium">{STATUS_LABELS[r.status]}</p>
                  <p className="text-xs text-slate-400">
                    Referred {new Date(r.attributedAt).toLocaleDateString()}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
