'use client';

import { useCallback, useEffect, useState } from 'react';
import { toMinor } from '@direct-order/money';
import {
  ApiError,
  restaurantApi,
  type RestaurantBrandingData,
  type RestaurantProfile,
  type RestaurantSettingsData,
} from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';

export default function RestaurantProfilePage() {
  return (
    <ProtectedRoute>
      <RestaurantProfileEditor />
    </ProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

function RestaurantProfileEditor() {
  const { user } = useSession();
  const restaurantId = user?.restaurantMemberships.find((m) => m.role !== 'STAFF')?.restaurantId;

  const [profile, setProfile] = useState<RestaurantProfile | null>(null);
  const [branding, setBranding] = useState<RestaurantBrandingData | null>(null);
  const [settings, setSettings] = useState<RestaurantSettingsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!restaurantId) return;
    try {
      const [p, b, s] = await Promise.all([
        restaurantApi.getProfile(restaurantId),
        restaurantApi.getBranding(restaurantId),
        restaurantApi.getSettings(restaurantId),
      ]);
      setProfile(p);
      setBranding(b);
      setSettings(s);
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!restaurantId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-slate-500">You don&apos;t manage a restaurant.</p>
      </main>
    );
  }

  if (!profile) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg items-center justify-center p-8">
        <p className="text-sm text-slate-500">{error ?? 'Loading…'}</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-10 p-8">
      <div>
        <h1 className="text-xl font-semibold">{profile.name}</h1>
        <p className="text-xs text-slate-400">
          /r/{profile.slug} · {profile.status}
        </p>
      </div>

      <ProfileSection restaurantId={restaurantId} profile={profile} onSaved={setProfile} />
      <BrandingSection restaurantId={restaurantId} branding={branding} onSaved={setBranding} />
      <SettingsSection restaurantId={restaurantId} settings={settings} onSaved={setSettings} />
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
      const updated = await restaurantApi.updateProfile(
        { description: description || undefined, phone: phone || undefined },
        restaurantId,
      );
      onSaved(updated);
    } catch (err) {
      setError(formatError(err));
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
          className="input"
          rows={3}
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Phone
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="input"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={saving} className="btn-primary w-fit">
        {saving ? 'Saving…' : 'Save profile'}
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
  const [themePrimaryColor, setThemePrimaryColor] = useState(branding?.themePrimaryColor ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const updated = await restaurantApi.updateBranding(
        { tagline: tagline || null, themePrimaryColor: themePrimaryColor || null },
        restaurantId,
      );
      onSaved(updated);
    } catch (err) {
      setError(formatError(err));
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
          className="input"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Primary color
        <input
          type="text"
          placeholder="#ff5722"
          value={themePrimaryColor}
          onChange={(e) => setThemePrimaryColor(e.target.value)}
          className="input"
        />
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={saving} className="btn-primary w-fit">
        {saving ? 'Saving…' : 'Save branding'}
      </button>
    </form>
  );
}

function SettingsSection({
  restaurantId,
  settings,
  onSaved,
}: {
  restaurantId: string;
  settings: RestaurantSettingsData | null;
  onSaved: (s: RestaurantSettingsData) => void;
}) {
  const [minOrderRupees, setMinOrderRupees] = useState(
    settings ? (Number(settings.minOrderAmountMinor) / 100).toString() : '',
  );
  const [acceptsOnlinePayment, setAcceptsOnlinePayment] = useState(
    settings?.acceptsOnlinePayment ?? false,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const minor = toMinor(minOrderRupees.trim() || '0');
      const updated = await restaurantApi.updateSettings(
        { minOrderAmountMinor: minor.toString(), acceptsOnlinePayment },
        restaurantId,
      );
      onSaved(updated);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-4 border-t border-slate-200 pt-8"
    >
      <h2 className="text-sm font-semibold text-slate-900">Settings</h2>
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Minimum order amount (₹)
        <input
          type="number"
          min="0"
          step="1"
          value={minOrderRupees}
          onChange={(e) => setMinOrderRupees(e.target.value)}
          className="input"
        />
      </label>
      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <input
          type="checkbox"
          checked={acceptsOnlinePayment}
          onChange={(e) => setAcceptsOnlinePayment(e.target.checked)}
        />
        Accept online payment
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={saving} className="btn-primary w-fit">
        {saving ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}
