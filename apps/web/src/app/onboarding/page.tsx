'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toMinor } from '@direct-order/money';
import { ApiError, restaurantApi, type RestaurantProfile } from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';

type Step = 'create' | 'profile' | 'branding' | 'settings' | 'review';
const STEPS: Step[] = ['create', 'profile', 'branding', 'settings', 'review'];

export default function OnboardingPage() {
  return (
    <ProtectedRoute>
      <OnboardingWizard />
    </ProtectedRoute>
  );
}

function OnboardingWizard() {
  const { user } = useSession();
  const [restaurant, setRestaurant] = useState<RestaurantProfile | null>(null);
  const [step, setStep] = useState<Step>('create');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      // Pilot scope: an owner completing onboarding has at most one
      // restaurant. Resuming means finding it and loading whatever was
      // already saved — nothing about "which step" lives in the browser.
      const membership = user?.restaurantMemberships[0];
      if (membership) {
        const profile = await restaurantApi.getProfile(membership.restaurantId);
        if (cancelled) return;
        setRestaurant(profile);
        setStep(profile.status === 'DRAFT' ? 'profile' : 'review');
      }
      if (!cancelled) setLoading(false);
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const goNext = useCallback(() => {
    setStep((current) => {
      const index = STEPS.indexOf(current);
      return STEPS[Math.min(index + 1, STEPS.length - 1)]!;
    });
  }, []);

  if (loading) {
    return <Centered>Loading…</Centered>;
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-8 p-8">
      <div>
        <h1 className="text-xl font-semibold">Set up your restaurant</h1>
        <StepIndicator current={step} />
      </div>

      {step === 'create' && <CreateStep onCreated={(r) => (setRestaurant(r), goNext())} />}
      {step === 'profile' && restaurant && (
        <ProfileStep restaurant={restaurant} onSaved={(r) => (setRestaurant(r), goNext())} />
      )}
      {step === 'branding' && restaurant && (
        <BrandingStep restaurantId={restaurant.id} onDone={goNext} />
      )}
      {step === 'settings' && restaurant && (
        <SettingsStep restaurantId={restaurant.id} onDone={goNext} />
      )}
      {step === 'review' && restaurant && <ReviewStep restaurant={restaurant} />}
    </main>
  );
}

function StepIndicator({ current }: { current: Step }) {
  const labels: Record<Step, string> = {
    create: 'Restaurant',
    profile: 'Profile & address',
    branding: 'Branding',
    settings: 'Settings',
    review: 'Review',
  };
  return (
    <ol className="mt-3 flex gap-3 text-xs text-slate-400">
      {STEPS.map((s, i) => (
        <li key={s} className={s === current ? 'font-semibold text-slate-900' : ''}>
          {i + 1}. {labels[s]}
        </li>
      ))}
    </ol>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
      {children}
    </div>
  );
}

function ErrorText({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="text-sm text-red-600">{error}</p>;
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.body.details?.length) {
      return err.body.details
        .map((d) => d.message)
        .filter(Boolean)
        .join(' ');
    }
    return err.body.message;
  }
  return 'Something went wrong.';
}

// ── Step 1: create ───────────────────────────────────────────────────

function CreateStep({ onCreated }: { onCreated: (r: RestaurantProfile) => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const created = await restaurantApi.create({ name, slug: slug.trim() || undefined });
      const profile = await restaurantApi.getProfile(created.id);
      onCreated(profile);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Restaurant name
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="input"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Custom URL{' '}
        <span className="font-normal text-slate-400">(optional — we&apos;ll suggest one)</span>
        <input
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="spice-route"
          className="input"
        />
      </label>
      <ErrorText error={error} />
      <button type="submit" disabled={submitting} className="btn-primary">
        {submitting ? 'Creating…' : 'Continue'}
      </button>
    </form>
  );
}

// ── Step 2: profile + address ────────────────────────────────────────

function ProfileStep({
  restaurant,
  onSaved,
}: {
  restaurant: RestaurantProfile;
  onSaved: (r: RestaurantProfile) => void;
}) {
  const [description, setDescription] = useState(restaurant.description ?? '');
  const [phone, setPhone] = useState(restaurant.phone ?? '');
  const [line1, setLine1] = useState(restaurant.address?.line1 ?? '');
  const [city, setCity] = useState(restaurant.address?.city ?? '');
  const [state, setState] = useState(restaurant.address?.state ?? '');
  const [postalCode, setPostalCode] = useState(restaurant.address?.postalCode ?? '');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const updated = await restaurantApi.updateProfile(
        {
          description: description || undefined,
          phone: phone || undefined,
          address: {
            line1,
            city,
            state,
            postalCode,
            line2: null,
            locality: null,
            latitude: null,
            longitude: null,
            landmark: null,
          },
        },
        restaurant.id,
      );
      onSaved(updated);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
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
      <h2 className="text-sm font-semibold text-slate-900">Pickup address</h2>
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Address line 1
        <input
          type="text"
          required
          value={line1}
          onChange={(e) => setLine1(e.target.value)}
          className="input"
        />
      </label>
      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-slate-700">
          City
          <input
            type="text"
            required
            value={city}
            onChange={(e) => setCity(e.target.value)}
            className="input"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-slate-700">
          State
          <input
            type="text"
            required
            value={state}
            onChange={(e) => setState(e.target.value)}
            className="input"
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
          className="input"
        />
      </label>
      <ErrorText error={error} />
      <button type="submit" disabled={submitting} className="btn-primary">
        {submitting ? 'Saving…' : 'Continue'}
      </button>
    </form>
  );
}

// ── Step 3: branding (optional) ──────────────────────────────────────

function BrandingStep({ restaurantId, onDone }: { restaurantId: string; onDone: () => void }) {
  const [tagline, setTagline] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (tagline.trim()) {
        await restaurantApi.updateBranding({ tagline }, restaurantId);
      }
      onDone();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Tagline <span className="font-normal text-slate-400">(optional)</span>
        <input
          type="text"
          value={tagline}
          onChange={(e) => setTagline(e.target.value)}
          placeholder="Authentic South Indian food"
          className="input"
        />
      </label>
      <p className="text-xs text-slate-400">
        Logo and cover image can be added later from your dashboard.
      </p>
      <ErrorText error={error} />
      <div className="flex gap-3">
        <button type="button" onClick={onDone} className="text-sm text-slate-500 underline">
          Skip
        </button>
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </form>
  );
}

// ── Step 4: settings (optional) ──────────────────────────────────────

function SettingsStep({ restaurantId, onDone }: { restaurantId: string; onDone: () => void }) {
  const [minOrderRupees, setMinOrderRupees] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (minOrderRupees.trim()) {
        // toMinor() takes the raw decimal string directly — a form
        // field's .value is already a string, and passing it straight
        // through (then back to a string for the request) avoids ever
        // round-tripping money through a JS number (packages/money's
        // whole reason for existing).
        const minor = toMinor(minOrderRupees.trim());
        await restaurantApi.updateSettings({ minOrderAmountMinor: minor.toString() }, restaurantId);
      }
      onDone();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
        Minimum order amount (₹) <span className="font-normal text-slate-400">(optional)</span>
        <input
          type="number"
          min="0"
          step="1"
          value={minOrderRupees}
          onChange={(e) => setMinOrderRupees(e.target.value)}
          placeholder="0"
          className="input"
        />
      </label>
      <p className="text-xs text-slate-400">
        Delivery fees and payment options can be configured later.
      </p>
      <ErrorText error={error} />
      <div className="flex gap-3">
        <button type="button" onClick={onDone} className="text-sm text-slate-500 underline">
          Skip
        </button>
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? 'Saving…' : 'Continue'}
        </button>
      </div>
    </form>
  );
}

// ── Step 5: review + submit ──────────────────────────────────────────

function ReviewStep({ restaurant }: { restaurant: RestaurantProfile }) {
  const router = useRouter();
  const [status, setStatus] = useState(restaurant.status);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const updated = await restaurantApi.submitOnboarding(restaurant.id);
      setStatus(updated.status);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (status !== 'DRAFT') {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-700">
          <strong>{restaurant.name}</strong> has been submitted and is{' '}
          {status === 'PENDING_APPROVAL' ? 'awaiting approval' : status.toLowerCase()}.
        </p>
        <button type="button" onClick={() => router.push('/account')} className="btn-primary w-fit">
          Go to account
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2 text-sm">
        <Row label="Name" value={restaurant.name} />
        <Row label="URL" value={`/r/${restaurant.slug}`} />
        {restaurant.address && <Row label="City" value={restaurant.address.city} />}
      </dl>
      <p className="text-xs text-slate-500">
        Submitting sends your restaurant for approval. You can keep editing your profile, branding,
        and settings afterwards.
      </p>
      <ErrorText error={error} />
      <button
        type="button"
        onClick={() => void handleSubmit()}
        disabled={submitting}
        className="btn-primary w-fit"
      >
        {submitting ? 'Submitting…' : 'Submit for approval'}
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-slate-100 py-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
