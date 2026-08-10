'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError, authApi } from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';

export default function AcceptInvitationPage() {
  return (
    <Suspense fallback={null}>
      <ProtectedRoute>
        <AcceptInvitation />
      </ProtectedRoute>
    </Suspense>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

function AcceptInvitation() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [status, setStatus] = useState<'idle' | 'accepting' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleAccept() {
    setStatus('accepting');
    setError(null);
    try {
      await authApi.acceptInvitation(token);
      setStatus('done');
    } catch (err) {
      setError(formatError(err));
      setStatus('error');
    }
  }

  if (!token) {
    return (
      <Centered>
        <p className="text-sm text-red-600">This link is missing its invitation token.</p>
      </Centered>
    );
  }

  if (status === 'done') {
    return (
      <Centered>
        <p className="text-sm text-slate-700">You&apos;ve joined the restaurant.</p>
        <button type="button" onClick={() => router.push('/account')} className="btn-primary">
          Go to account
        </button>
      </Centered>
    );
  }

  return (
    <Centered>
      <p className="text-sm text-slate-700">
        You&apos;ve been invited to join a restaurant on Direct-Order.
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        onClick={() => void handleAccept()}
        disabled={status === 'accepting'}
        className="btn-primary"
      >
        {status === 'accepting' ? 'Accepting…' : 'Accept invitation'}
      </button>
      <Link href="/account" className="text-sm text-slate-500 underline">
        Not now
      </Link>
    </Centered>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 p-8 text-center">
      {children}
    </main>
  );
}
