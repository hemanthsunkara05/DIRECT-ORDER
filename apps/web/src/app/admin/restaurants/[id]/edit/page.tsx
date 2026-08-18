'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { AdminGuard } from '@/lib/auth/admin-guard';
import {
  ApiError,
  adminApi,
  type RestaurantAddressInput,
  type RestaurantBrandingData,
  type RestaurantProfile,
} from '@/lib/api-client';
import { ReasonModal } from '@/components/ui/ReasonModal';
import { StatusPill, RESTAURANT_STATUS_TONE, statusLabel } from '@/components/ui/StatusPill';

export default function AdminEditRestaurantPage() {
  return (
    <AdminGuard>
      <EditRestaurant />
    </AdminGuard>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

/**
 * Admin-authorized profile/address/branding/hours editor (Phase 22) —
 * calls the same service logic the owner's own /restaurant/profile page
 * does, through the admin-only endpoints. Deliberately a fresh, smaller
 * set of components rather than a refactor of the owner-side page (see
 * the phase plan's frontend-reuse note): the owner page's sections are
 * hard-wired to restaurantApi/menuApi, and threading an injectable API
 * namespace through them is a bigger diff than this internal tool needs.
 */
function EditRestaurant() {
  const params = useParams<{ id: string }>();
  const restaurantId = params.id;

  const [profile, setProfile] = useState<RestaurantProfile | null>(null);
  const [branding, setBranding] = useState<RestaurantBrandingData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, b] = await Promise.all([
        adminApi.restaurants.content.getProfile(restaurantId),
        adminApi.restaurants.content.getBranding(restaurantId),
      ]);
      setProfile(p);
      setBranding(b);
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmitForApproval() {
    setStatusBusy(true);
    setError(null);
    try {
      const updated = await adminApi.restaurants.content.submitForApproval(restaurantId);
      setProfile((prev) => (prev ? { ...prev, status: updated.status } : prev));
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStatusBusy(false);
    }
  }

  async function handleApprove() {
    setStatusBusy(true);
    setError(null);
    try {
      const res = await adminApi.restaurants.approve(restaurantId);
      setProfile((prev) =>
        prev ? { ...prev, status: res.status as RestaurantProfile['status'] } : prev,
      );
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStatusBusy(false);
    }
  }

  async function handleReject(reason: string) {
    setStatusBusy(true);
    setError(null);
    try {
      const res = await adminApi.restaurants.reject(restaurantId, reason);
      setProfile((prev) =>
        prev ? { ...prev, status: res.status as RestaurantProfile['status'] } : prev,
      );
      setRejecting(false);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setStatusBusy(false);
    }
  }

  if (!profile) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg items-center justify-center p-8">
        <p className="text-sm text-slate-500">{error ?? 'Loading…'}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-10 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{profile.name}</h1>
          <p className="text-xs text-slate-400">/r/{profile.slug}</p>
        </div>
        <StatusPill
          label={statusLabel(profile.status)}
          tone={RESTAURANT_STATUS_TONE[profile.status] ?? 'ink'}
        />
      </div>

      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 pb-6">
        <Link
          href={`/admin/restaurants/${restaurantId}/menu`}
          className="text-sm text-indigo-600 underline"
        >
          Edit menu →
        </Link>
        {profile.status === 'DRAFT' && (
          <button
            type="button"
            disabled={statusBusy}
            onClick={() => void handleSubmitForApproval()}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
          >
            Submit for approval
          </button>
        )}
        {profile.status === 'PENDING_APPROVAL' && (
          <>
            <button
              type="button"
              disabled={statusBusy}
              onClick={() => void handleApprove()}
              className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
            >
              Approve
            </button>
            <button
              type="button"
              disabled={statusBusy}
              onClick={() => setRejecting(true)}
              className="text-sm text-red-600 underline disabled:cursor-not-allowed"
            >
              Reject
            </button>
          </>
        )}
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <ProfileSection restaurantId={restaurantId} profile={profile} onSaved={setProfile} />
      <AddressSection restaurantId={restaurantId} profile={profile} onSaved={setProfile} />
      <BrandingSection restaurantId={restaurantId} branding={branding} onSaved={setBranding} />
      <HoursSection restaurantId={restaurantId} />

      {rejecting && (
        <ReasonModal
          title="Reject restaurant"
          consequence="The restaurant will be notified and can fix the issue and resubmit."
          confirmLabel="Reject"
          confirmTone="error"
          onConfirm={(reason) => void handleReject(reason)}
          onCancel={() => setRejecting(false)}
        />
      )}
    </main>
  );
}

function ProfileSection({
  restaurantId,
  profile,
  onSaved,
}: {
  restaurantId: string;
  profile: RestaurantProfile;
  onSaved: (p: RestaurantProfile) => void;
}) {
  const [description, setDescription] = useState(profile.description ?? '');
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await adminApi.restaurants.content.updateProfile(restaurantId, {
        description: description || undefined,
        phone: phone || undefined,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-slate-900">Profile</h2>
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Description
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          rows={3}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Phone
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={saving}
        className="w-fit rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {saving ? 'Saving…' : 'Save profile'}
      </button>
    </form>
  );
}

function AddressSection({
  restaurantId,
  profile,
  onSaved,
}: {
  restaurantId: string;
  profile: RestaurantProfile;
  onSaved: (p: RestaurantProfile) => void;
}) {
  const existing = profile.address;
  const [line1, setLine1] = useState(existing?.line1 ?? '');
  const [city, setCity] = useState(existing?.city ?? '');
  const [state, setState] = useState(existing?.state ?? '');
  const [postalCode, setPostalCode] = useState(existing?.postalCode ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const address: RestaurantAddressInput = { line1, city, state, postalCode };
      const updated = await adminApi.restaurants.content.updateProfile(restaurantId, { address });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-4 border-t border-slate-200 pt-8"
    >
      <h2 className="text-sm font-semibold text-slate-900">Address</h2>
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Address line 1
        <input
          type="text"
          required
          value={line1}
          onChange={(e) => setLine1(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          City
          <input
            type="text"
            required
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          State
          <input
            type="text"
            required
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Postal code
        <input
          type="text"
          required
          value={postalCode}
          onChange={(e) => setPostalCode(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={saving}
        className="w-fit rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {saving ? 'Saving…' : 'Save address'}
      </button>
    </form>
  );
}

function BrandingSection({
  restaurantId,
  branding,
  onSaved,
}: {
  restaurantId: string;
  branding: RestaurantBrandingData | null;
  onSaved: (b: RestaurantBrandingData) => void;
}) {
  const [tagline, setTagline] = useState(branding?.tagline ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await adminApi.restaurants.content.updateBranding(restaurantId, {
        tagline: tagline || null,
      });
      onSaved(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-4 border-t border-slate-200 pt-8"
    >
      <h2 className="text-sm font-semibold text-slate-900">Branding</h2>
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Tagline
        <input
          type="text"
          value={tagline}
          onChange={(e) => setTagline(e.target.value)}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={saving}
        className="w-fit rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {saving ? 'Saving…' : 'Save branding'}
      </button>
    </form>
  );
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function HoursSection({ restaurantId }: { restaurantId: string }) {
  const [days, setDays] = useState<
    { dayOfWeek: number; opensAt: string; closesAt: string; isClosed: boolean }[] | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    adminApi.restaurants.content
      .getHours(restaurantId)
      .then((rows) => {
        if (rows.length === 7) {
          setDays(rows.map((r) => ({ ...r })));
        } else {
          setDays(
            Array.from({ length: 7 }, (_, dayOfWeek) => ({
              dayOfWeek,
              opensAt: '09:00',
              closesAt: '22:00',
              isClosed: false,
            })),
          );
        }
      })
      .catch((err) =>
        setError(err instanceof ApiError ? err.body.message : 'Something went wrong.'),
      );
  }, [restaurantId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!days) return;
    setError(null);
    setSaving(true);
    try {
      await adminApi.restaurants.content.setHours(restaurantId, days);
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  if (!days) {
    return (
      <div className="border-t border-slate-200 pt-8">
        <h2 className="text-sm font-semibold text-slate-900">Hours</h2>
        <p className="mt-2 text-sm text-slate-500">{error ?? 'Loading…'}</p>
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-4 border-t border-slate-200 pt-8"
    >
      <h2 className="text-sm font-semibold text-slate-900">Hours</h2>
      {days.map((day, i) => (
        <div key={day.dayOfWeek} className="flex items-center gap-3 text-sm">
          <span className="w-10 text-slate-500">{DAY_NAMES[day.dayOfWeek]}</span>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={!day.isClosed}
              onChange={(e) => {
                const next = [...days];
                next[i] = { ...day, isClosed: !e.target.checked };
                setDays(next);
              }}
            />
            Open
          </label>
          {!day.isClosed && (
            <>
              <input
                type="time"
                value={day.opensAt}
                onChange={(e) => {
                  const next = [...days];
                  next[i] = { ...day, opensAt: e.target.value };
                  setDays(next);
                }}
                className="rounded-md border border-slate-300 px-2 py-1"
              />
              <span>–</span>
              <input
                type="time"
                value={day.closesAt}
                onChange={(e) => {
                  const next = [...days];
                  next[i] = { ...day, closesAt: e.target.value };
                  setDays(next);
                }}
                className="rounded-md border border-slate-300 px-2 py-1"
              />
            </>
          )}
        </div>
      ))}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={saving}
        className="w-fit rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {saving ? 'Saving…' : 'Save hours'}
      </button>
    </form>
  );
}
