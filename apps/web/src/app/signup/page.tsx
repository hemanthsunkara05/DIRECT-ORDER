'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, authApi } from '@/lib/api-client';
import { PasswordInput } from '@/components/ui/PasswordInput';

type Step = 'register' | 'verify';

export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}

function SignupForm() {
  const router = useRouter();
  // Outreach claim link: /signup?claim=<slug> — carried through to
  // /login so a fresh account can claim that listing right after its
  // first successful login (see /login's own claimSlug handling).
  const claimSlug = useSearchParams().get('claim');
  const loginHref = claimSlug ? `/login?claim=${encodeURIComponent(claimSlug)}` : '/login';
  const [step, setStep] = useState<Step>('register');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await authApi.register({ email, fullName, password });
      setMessage(res.message);
      setStep('verify');
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorMessage(err) : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await authApi.verifyOtp({ identifier: email, purpose: 'EMAIL_VERIFICATION', code });
      router.push(loginHref);
    } catch (err) {
      setError(err instanceof ApiError ? formatErrorMessage(err) : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <h1 className="text-xl font-semibold">Create your restaurant account</h1>

      {step === 'register' && (
        <form onSubmit={(e) => void handleRegister(e)} className="flex flex-col gap-4">
          <Field label="Full name">
            <input
              type="text"
              required
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Email">
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
            />
          </Field>
          <Field label="Password">
            <PasswordInput
              required
              minLength={10}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input w-full"
            />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Creating account…' : 'Create account'}
          </button>
        </form>
      )}

      {step === 'verify' && (
        <form onSubmit={(e) => void handleVerify(e)} className="flex flex-col gap-4">
          {message && <p className="text-sm text-slate-600">{message}</p>}
          <Field label="Verification code">
            <input
              type="text"
              required
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="input"
            />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Verifying…' : 'Verify email'}
          </button>
        </form>
      )}

      <p className="text-sm text-slate-500">
        Already have an account?{' '}
        <Link href={loginHref} className="underline">
          Log in
        </Link>
      </p>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
      {label}
      {children}
    </label>
  );
}

function formatErrorMessage(err: ApiError): string {
  if (err.body.details?.length) {
    return err.body.details
      .map((d) => d.message)
      .filter(Boolean)
      .join(' ');
  }
  return err.body.message;
}
