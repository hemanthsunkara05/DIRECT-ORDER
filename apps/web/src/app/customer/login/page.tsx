'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, customerAuthApi } from '@/lib/api-client';
import { useSession } from '@/lib/auth/session-context';

/**
 * AMB-2's "lightweight optional account" (phone-OTP, no password) —
 * the customer-facing counterpart to `/login` (staff/admin). Guest
 * checkout remains the default everywhere else in the app; this page
 * exists only for a customer who WANTS a wallet/referral history
 * across orders. `useSession()` is the same app-global session
 * context `/login` uses — `AuthGuard` on the API side resolves a
 * customer session identically to a staff one, so no separate context
 * is needed here.
 *
 * Wrapped in `Suspense` (Next.js requirement for `useSearchParams()`
 * on a statically-prerendered route — the `?ref=` referral code query
 * param, unlike `/orders/[orderNumber]`'s dynamic route, would
 * otherwise fail the production build with a CSR-bailout error).
 */
export default function CustomerLoginPage() {
  return (
    <Suspense fallback={null}>
      <CustomerLoginForm />
    </Suspense>
  );
}

function CustomerLoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refresh } = useSession();
  const [step, setStep] = useState<'phone' | 'code'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const referralCode = searchParams.get('ref') ?? undefined;

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await customerAuthApi.requestOtp(phone);
      setStep('code');
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerifyCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await customerAuthApi.verifyOtp({
        phone,
        code,
        fullName: fullName.trim() || undefined,
        referralCode,
      });
      await refresh();
      router.push('/customer/wallet');
    } catch (err) {
      setError(
        err instanceof ApiError
          ? 'That code is invalid, expired, or has been used too many times.'
          : 'Something went wrong.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <div>
        <h1 className="text-xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-slate-500">
          No password needed — we&rsquo;ll text you a one-time code.
        </p>
      </div>

      {step === 'phone' ? (
        <form onSubmit={(e) => void handleRequestCode(e)} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Phone number
            <input
              type="tel"
              required
              placeholder="+91XXXXXXXXXX"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="input"
            />
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Sending…' : 'Send code'}
          </button>
        </form>
      ) : (
        <form onSubmit={(e) => void handleVerifyCode(e)} className="flex flex-col gap-4">
          <p className="text-sm text-slate-500">Enter the code sent to {phone}.</p>
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Code
            <input
              type="text"
              required
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="input"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
            Your name (first time only)
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="input"
            />
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Verifying…' : 'Verify and continue'}
          </button>
          <button type="button" onClick={() => setStep('phone')} className="btn-secondary">
            Use a different number
          </button>
        </form>
      )}
    </main>
  );
}
