'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, authApi, type CurrentUser } from '../api-client';

export interface SessionContextValue {
  user: CurrentUser | null;
  /** True only during the initial /auth/me check on mount — not on every refetch. */
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Wraps the app (see layout.tsx), holding the current principal in
 * memory — never in localStorage/sessionStorage, since the actual
 * session lives in HttpOnly cookies the browser already manages. On
 * mount it asks the API "who am I" once; `GET /auth/me` returning 401
 * simply means "not logged in," not an error to surface.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setUser(await authApi.me());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUser(null);
      } else {
        throw error;
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    refresh()
      // A genuinely unexpected failure (network error, 500) — surfaced
      // for debugging rather than left as an unhandled rejection, but
      // still treated as "not logged in" below: a page that can't
      // confirm a session exists must not render as if one does.
      .catch((error: unknown) => {
        console.error('Failed to load the current session', error);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  const logout = useCallback(async () => {
    await authApi.logout();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, refresh, logout }),
    [user, loading, refresh, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession() must be used within <SessionProvider>.');
  }
  return ctx;
}
