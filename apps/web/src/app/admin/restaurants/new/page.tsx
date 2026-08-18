'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AdminGuard } from '@/lib/auth/admin-guard';
import { ApiError, adminApi, type AdminRestaurant } from '@/lib/api-client';

export default function NewAdminRestaurantPage() {
  return (
    <AdminGuard>
      <CreateRestaurantForm />
    </AdminGuard>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

/**
 * Concierge onboarding (Phase 22): an admin creates a restaurant on an
 * owner's behalf, either pre-claiming it to a known account (ownerEmail/
 * ownerPhone) or leaving it placeholder-owned — the exact same shape as
 * every other unclaimed outreach listing, no separate "Prospect" concept.
 */
function CreateRestaurantForm() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Advisory duplicate-name detection (docs/06 BR-173) — never blocks
  // creation, just surfaces existing names so the admin can eyeball it.
  const [nameMatches, setNameMatches] = useState<AdminRestaurant[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (name.trim().length < 3) {
      setNameMatches([]);
      return;
    }
    debounceRef.current = setTimeout(() => {
      adminApi.restaurants
        .list({ search: name.trim() })
        .then((page) => setNameMatches(page.items))
        .catch(() => setNameMatches([]));
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [name]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const created = await adminApi.restaurants.create({
        name: name.trim(),
        phone: phone.trim() || undefined,
        ownerEmail: ownerEmail.trim() || undefined,
        ownerPhone: ownerPhone.trim() || undefined,
      });
      router.push(`/admin/restaurants/${created.id}/edit`);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">New restaurant</h1>
        <p className="mt-1 text-sm text-slate-500">
          For concierge onboarding — set up a listing while on a call with the owner. You can add
          the menu, hours, and full address afterward.
        </p>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Restaurant name
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        {nameMatches.length > 0 && (
          <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Possible existing match: {nameMatches.map((r) => r.name).join(', ')}. This is advisory
            only — creating is never blocked.
          </p>
        )}

        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Restaurant phone (optional)
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>

        <div className="rounded-md border border-slate-200 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Owner (optional)
          </p>
          <p className="mb-3 text-xs text-slate-500">
            If the owner already has an account, enter their email or phone to assign it to them
            immediately. Leave blank to create an unclaimed listing you can send a claim link for
            later — it works exactly like every other outreach listing.
          </p>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Owner email
              <input
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                className="rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
              Owner phone
              <input
                type="tel"
                value={ownerPhone}
                onChange={(e) => setOwnerPhone(e.target.value)}
                className="rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-fit rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {submitting ? 'Creating…' : 'Create restaurant'}
        </button>
      </form>
    </main>
  );
}
