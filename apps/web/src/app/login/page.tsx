'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, authApi, restaurantApi } from '@/lib/api-client';
import { useSession } from '@/lib/auth/session-context';
import { PasswordInput } from '@/components/ui/PasswordInput';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const { refresh } = useSession();
  // Carried from an outreach claim link (see /signup) — a restaurant
  // slug this login should claim on success, landing the new owner in
  // onboarding instead of the plain account page.
  const claimSlug = useSearchParams().get('claim');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // refresh() re-fetches /auth/me rather than trusting login's own
      // response, so SessionProvider's state always matches what the
      // API — the actual source of truth — currently says.
      await authApi.login({ email, password });
      await refresh();
      if (claimSlug) {
        try {
          await restaurantApi.claim(claimSlug);
        } catch {
          // Already claimed, or this account already owns a restaurant —
          // either way, still a real logged-in session; land on /account
          // rather than blocking the login that just succeeded.
          router.push('/account');
          return;
        }
        // The claim just created this account's first restaurantStaff
        // membership — refresh() again so SessionProvider's user carries
        // it. Without this, /onboarding reads the pre-claim session (no
        // memberships) and drops the new owner into "create a restaurant"
        // instead of resuming the one they just claimed.
        await refresh();
        router.push('/onboarding');
        return;
      }
      router.push('/account');
    } catch (err) {
      // Deliberately the same generic message for every failure reason
      // (wrong password, unknown account, locked, disabled) — the API
      // already collapses these; the UI must not reintroduce a
      // distinction by showing different copy per error code.
      setError(err instanceof ApiError ? 'Invalid email or password.' : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <h1 className="text-xl font-semibold">Log in</h1>
      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Password
          <PasswordInput
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input w-full"
          />
        </label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? 'Logging in…' : 'Log in'}
        </button>
      </form>
      <div className="flex justify-between text-sm text-slate-500">
        <Link href="/signup" className="underline">
          Create an account
        </Link>
        <Link href="/forgot-password" className="underline">
          Forgot password?
        </Link>
      </div>
    </main>
  );
}
