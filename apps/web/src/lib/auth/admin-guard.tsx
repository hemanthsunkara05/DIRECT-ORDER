'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, adminApi } from '../api-client';

/**
 * Client-side convenience only, same caveat as `ProtectedRoute`
 * (docs/09-security.md §15.2) — `AuthorizationGuard` at the API is the
 * real enforcement, including the MFA-verified-this-session check this
 * component has no way to inspect directly. This just avoids a flash of
 * admin UI for a session that the very first API call would 403 anyway,
 * by making that first call itself the check (`GET /admin/overview`,
 * "Any admin" — the lowest bar any real admin session clears).
 */
export function AdminGuard({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<'checking' | 'ok' | 'denied'>('checking');

  useEffect(() => {
    let cancelled = false;
    adminApi
      .overview()
      .then(() => {
        if (!cancelled) setStatus('ok');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          router.replace('/admin/login');
        }
        setStatus('denied');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (status !== 'ok') {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        {status === 'checking' ? 'Checking admin access…' : 'Redirecting…'}
      </div>
    );
  }

  return <>{children}</>;
}
