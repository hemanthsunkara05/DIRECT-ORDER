'use client';

import { useCallback, useEffect, useState } from 'react';
import { formatINR, toMinor } from '@direct-order/money';
import {
  ApiError,
  promotionsApi,
  type Promotion,
  type PromotionCreateInput,
} from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';

export default function RestaurantPromotionsPage() {
  return (
    <ProtectedRoute>
      <PromotionsManager />
    </ProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

function PromotionsManager() {
  const { user } = useSession();
  const restaurantId = user?.restaurantMemberships.find((m) => m.role !== 'STAFF')?.restaurantId;

  const [promotions, setPromotions] = useState<Promotion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!restaurantId) return;
    try {
      setPromotions(await promotionsApi.list(restaurantId));
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleToggle(promo: Promotion) {
    if (!restaurantId) return;
    setBusyId(promo.id);
    try {
      await promotionsApi.setActive(promo.id, !promo.isActive, restaurantId);
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  }

  if (!restaurantId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-slate-500">You don&apos;t manage a restaurant.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 p-8">
      <div>
        <h1 className="text-xl font-semibold">Promotions</h1>
        <p className="text-xs text-slate-500">
          Coupon codes customers can enter at checkout. Only one promotion applies per order.
        </p>
      </div>

      <CreatePromotionForm restaurantId={restaurantId} onCreated={load} />

      {error && <p className="text-sm text-red-600">{error}</p>}

      <ul className="flex flex-col gap-2">
        {promotions?.map((promo) => (
          <li
            key={promo.id}
            className="flex items-center justify-between rounded-lg border border-slate-200 p-3 text-sm"
          >
            <div>
              <span className="font-mono font-medium">{promo.code}</span>
              <span className="ml-2 text-slate-500">
                {promo.type === 'PERCENTAGE'
                  ? `${promo.value}% off`
                  : promo.type === 'FREE_DELIVERY'
                    ? 'Free delivery'
                    : `${formatINR(BigInt(promo.value))} off`}
              </span>
              <span
                className={`ml-2 rounded px-1.5 py-0.5 text-xs ${
                  promo.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'
                }`}
              >
                {promo.isActive ? 'Active' : 'Paused'}
              </span>
            </div>
            <button
              type="button"
              disabled={busyId === promo.id}
              onClick={() => void handleToggle(promo)}
              className="btn-secondary disabled:cursor-not-allowed"
            >
              {promo.isActive ? 'Pause' : 'Resume'}
            </button>
          </li>
        ))}
      </ul>
      {promotions !== null && promotions.length === 0 && (
        <p className="text-sm text-slate-500">No promotions yet.</p>
      )}
    </main>
  );
}

function CreatePromotionForm({
  restaurantId,
  onCreated,
}: {
  restaurantId: string;
  onCreated: () => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [type, setType] = useState<PromotionCreateInput['type']>('PERCENTAGE');
  const [value, setValue] = useState('10');
  const [usageLimitTotal, setUsageLimitTotal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await promotionsApi.create(
        {
          code,
          name: code,
          type,
          value: type === 'FIXED_AMOUNT' ? Number(toMinor(value || '0')) : Number(value),
          usageLimitTotal: usageLimitTotal ? Number(usageLimitTotal) : undefined,
        },
        restaurantId,
      );
      setCode('');
      setValue('10');
      setUsageLimitTotal('');
      await onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-4 rounded-lg border border-slate-200 p-4"
    >
      <h2 className="text-sm font-semibold text-slate-900">New promotion</h2>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Code
          <input
            type="text"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="WELCOME10"
            className="input"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Type
          <select
            value={type}
            onChange={(e) => setType(e.target.value as PromotionCreateInput['type'])}
            className="input"
          >
            <option value="PERCENTAGE">Percentage off</option>
            <option value="FIXED_AMOUNT">Fixed amount off (₹)</option>
            <option value="FREE_DELIVERY">Free delivery</option>
          </select>
        </label>
        {type !== 'FREE_DELIVERY' && (
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            {type === 'PERCENTAGE' ? 'Percent (1-100)' : 'Amount (₹)'}
            <input
              type="number"
              min="1"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="input"
            />
          </label>
        )}
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Total uses (optional)
          <input
            type="number"
            min="1"
            value={usageLimitTotal}
            onChange={(e) => setUsageLimitTotal(e.target.value)}
            placeholder="Unlimited"
            className="input"
          />
        </label>
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={saving} className="btn-primary w-fit">
        {saving ? 'Creating…' : 'Create promotion'}
      </button>
    </form>
  );
}
