'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, authApi, mfaApi } from '@/lib/api-client';
import { useSession } from '@/lib/auth/session-context';

/**
 * A separate login flow from the restaurant-facing `/login` page — Phase
 * 13's admin console has its own two-step authentication (password,
 * then a mandatory TOTP code) and there is no reason to complicate the
 * restaurant-owner login for the 99% of users who are never admins.
 * `AuthorizationGuard` is the actual enforcement point (docs/14-
 * acceptance-criteria.md: "Admin MFA is enforced at the API, not only
 * in the UI") — this page failing open would still 403 on every real
 * admin request.
 */
export default function AdminLoginPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authApi.login({ email, password });
      setStep('mfa');
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await mfaApi.verify(code);
      // Same reasoning as /login's own post-auth refresh() — the session
      // cookie now belongs to this admin, but SessionProvider's `user`
      // won't reflect that until asked again; without this, AdminSidebar
      // would show whoever was last signed in on this browser, not the
      // admin who just verified.
      await refresh();
      router.push('/admin');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.body.message
          : 'Verification failed. This account may not have admin access.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <h1 className="text-xl font-semibold">Admin sign in</h1>

      {step === 'password' && (
        <form onSubmit={(e) => void handlePasswordSubmit(e)} className="flex flex-col gap-3">
          <input
            type="email"
            placeholder="Email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <input
            type="password"
            placeholder="Password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={busy} className="btn-primary disabled:cursor-not-allowed">
            {busy ? 'Signing in…' : 'Continue'}
          </button>
        </form>
      )}

      {step === 'mfa' && (
        <form onSubmit={(e) => void handleMfaSubmit(e)} className="flex flex-col gap-3">
          <p className="text-sm text-slate-600">
            Enter the 6-digit code from your authenticator app.
          </p>
          <input
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            placeholder="123456"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="rounded-md border border-slate-300 px-3 py-2 text-center text-lg tracking-widest"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={busy} className="btn-primary disabled:cursor-not-allowed">
            {busy ? 'Verifying…' : 'Verify'}
          </button>
        </form>
      )}
    </main>
  );
}
