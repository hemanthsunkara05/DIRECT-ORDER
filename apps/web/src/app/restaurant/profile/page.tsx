'use client';

import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
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

      <OrderingLinkSection slug={profile.slug} />
      <ProfileSection restaurantId={restaurantId} profile={profile} onSaved={setProfile} />
      <BrandingSection restaurantId={restaurantId} branding={branding} onSaved={setBranding} />
      <SettingsSection restaurantId={restaurantId} settings={settings} onSaved={setSettings} />
    </main>
  );
}

/**
 * The ordering link is `{origin}/r/{slug}` — `slug` is permanent by design
 * (docs/15-ambiguities-and-risks.md: printed QR codes can't be recalled, so
 * slugs are never reassigned once created, and no endpoint exists to change
 * one). The QR code is generated fresh in the browser every render rather
 * than stored anywhere: encoding the same URL always produces the same QR
 * code, so "never regenerated" falls out of that determinism for free —
 * there is nothing to keep in sync or invalidate.
 */
function OrderingLinkSection({ slug }: { slug: string }) {
  const [origin, setOrigin] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const link = origin ? `${origin}/r/${slug}` : null;

  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    QRCode.toDataURL(link, { width: 320, margin: 2 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setError('Could not generate the QR code.');
      });
    return () => {
      cancelled = true;
    };
  }, [link]);

  async function handleCopy() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex flex-col gap-4 border-t border-slate-200 pt-8">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">Ordering link & QR code</h2>
        <p className="text-xs text-slate-500">
          Permanent — tied to your restaurant&apos;s URL slug, which never changes. Safe to print on
          packaging, table cards, or share on social media; this same link and QR code will always
          be used.
        </p>
      </div>

      {link && (
        <div className="flex flex-col gap-2">
          <span className="break-all font-mono text-sm text-slate-700">{link}</span>
          <button type="button" onClick={() => void handleCopy()} className="btn-secondary w-fit">
            {copied ? 'Copied!' : 'Copy link'}
          </button>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {qrDataUrl && (
        <div className="flex flex-col items-start gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL generated client-side, next/image cannot optimize it and doesn't need to. */}
          <img
            src={qrDataUrl}
            alt={`QR code linking to ${link}`}
            width={200}
            height={200}
            className="rounded-md border border-slate-200"
          />
          <a href={qrDataUrl} download={`${slug}-qr-code.png`} className="btn-secondary w-fit">
            Download QR code
          </a>
        </div>
      )}
    </div>
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
