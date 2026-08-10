'use client';

import { useState } from 'react';
import Link from 'next/link';
import { authApi } from '@/lib/api-client';

const GENERIC_CONFIRMATION = "If that email is registered, we've sent a password reset link.";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await authApi.forgotPassword(email);
    } finally {
      // Shown unconditionally, success or failure — the API's own
      // response is already identical either way (docs/09-security.md
      // §15.2); the UI mirrors that rather than branching on the result.
      setSubmitting(false);
      setSubmitted(true);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <h1 className="text-xl font-semibold">Reset your password</h1>

      {submitted ? (
        <p className="text-sm text-slate-600">{GENERIC_CONFIRMATION}</p>
      ) : (
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
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}

      <Link href="/login" className="text-sm text-slate-500 underline">
        Back to log in
      </Link>
    </main>
  );
}
