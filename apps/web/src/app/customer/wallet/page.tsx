'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  ApiError,
  loyaltyApi,
  type LoyaltyBalance,
  type LoyaltyLedgerEntry,
} from '@/lib/api-client';
import { CustomerProtectedRoute } from '@/lib/auth/customer-protected-route';
import { useSession } from '@/lib/auth/session-context';

export default function CustomerWalletPage() {
  return (
    <CustomerProtectedRoute>
      <WalletView />
    </CustomerProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

const LEDGER_TYPE_LABELS: Record<string, string> = {
  ORDER_EARN: 'Earned on order',
  REDEMPTION: 'Redeemed at checkout',
  REFUND_CLAWBACK: 'Clawed back (refund)',
  ADMIN_ADJUSTMENT: 'Adjustment',
  EXPIRATION: 'Expired',
  REFERRAL_REWARD: 'Referral reward',
};

function WalletView() {
  const { user, logout } = useSession();
  const [balance, setBalance] = useState<LoyaltyBalance | null>(null);
  const [ledger, setLedger] = useState<LoyaltyLedgerEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [balanceRes, ledgerRes] = await Promise.all([loyaltyApi.balance(), loyaltyApi.ledger()]);
      setBalance(balanceRes);
      setLedger(ledgerRes.items);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Your wallet</h1>
        <button type="button" onClick={() => void logout()} className="btn-secondary text-sm">
          Log out
        </button>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {balance && (
        <section className="rounded-lg border border-slate-200 p-5 text-center">
          <p className="text-sm text-slate-500">{user?.fullName}</p>
          <p className="mt-2 text-4xl font-bold">{balance.balancePoints}</p>
          <p className="text-sm text-slate-500">loyalty points</p>
          <dl className="mt-4 flex justify-center gap-8 text-sm">
            <div>
              <dt className="text-slate-500">Lifetime earned</dt>
              <dd className="font-medium">{balance.lifetimeEarned}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Lifetime redeemed</dt>
              <dd className="font-medium">{balance.lifetimeRedeemed}</dd>
            </div>
          </dl>
          {balance.balancePoints < 0 && (
            <p className="mt-3 text-sm text-amber-600">
              Your balance is negative after a refund clawback — you won&rsquo;t be able to redeem
              points until it recovers.
            </p>
          )}
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-semibold">History</h2>
          <Link href="/customer/referrals" className="text-sm text-blue-600 underline">
            Refer a friend →
          </Link>
        </div>
        {ledger === null ? (
          <p className="text-sm text-slate-500">Loading…</p>
        ) : ledger.length === 0 ? (
          <p className="text-sm text-slate-500">No activity yet.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-slate-200 rounded-lg border border-slate-200">
            {ledger.map((entry) => (
              <li key={entry.id} className="flex items-center justify-between p-3 text-sm">
                <div>
                  <p className="font-medium">{LEDGER_TYPE_LABELS[entry.type] ?? entry.type}</p>
                  {entry.description && (
                    <p className="text-slate-500">{entry.description}</p>
                  )}
                  <p className="text-xs text-slate-400">
                    {new Date(entry.createdAt).toLocaleString()}
                  </p>
                </div>
                <span className={entry.points >= 0 ? 'text-emerald-600' : 'text-red-600'}>
                  {entry.points >= 0 ? '+' : ''}
                  {entry.points}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
