'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from './session-context';

/**
 * Client-side gate only — convenience for the browser UX (redirect
 * instead of a flash of protected content), NOT the source of truth for
 * access control. Every protected page's actual data still comes from
 * API calls that require the session cookie, and the API re-derives
 * authority per request regardless of what this component does
 * (docs/09-security.md §15.2). A user with devtools open and no cookie
 * cannot see real data by skipping this redirect.
 */
export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useSession();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) {
      router.replace('/login');
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
