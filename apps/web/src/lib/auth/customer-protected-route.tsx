'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from './session-context';

/**
 * `ProtectedRoute`'s customer-facing counterpart (Phase 16) — identical
 * shape, redirecting to `/customer/login` instead of the staff `/login`.
 * Kept as its own component rather than a parameterised prop on
 * `ProtectedRoute` so every existing staff page's redirect target stays
 * exactly as it was, unaffected by this addition. Same caveat applies:
 * a client-side convenience only, not the access-control boundary — the
 * API re-derives authority per request regardless.
 */
export function CustomerProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/customer/login');
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }

  return <>{children}</>;
}
