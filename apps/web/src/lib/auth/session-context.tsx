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
  /**
   * The restaurant a multi-restaurant staff member is currently "acting
   * as" — the tenant switcher's own state (RestaurantSidebar). `null`
   * until `user` loads; defaults to the first membership. Every
   * `/restaurant/*` page should read this rather than hardcoding
   * `restaurantMemberships[0]`, so switching restaurants in the sidebar
   * actually changes what the rest of the dashboard shows.
   */
  activeRestaurantId: string | null;
  setActiveRestaurantId: (id: string) => void;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const ACTIVE_RESTAURANT_STORAGE_KEY = 'do_active_restaurant_id';

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
  const [activeRestaurantId, setActiveRestaurantIdState] = useState<string | null>(null);

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
    setActiveRestaurantIdState(null);
  }, []);

  // Resolves whenever the membership list changes (login, logout, a
  // membership added/removed) — a stored id from a previous session
  // that's no longer in the list (or was never set) falls back to the
  // first membership, never a dangling reference to a restaurant this
  // principal can't act as.
  useEffect(() => {
    if (!user || user.restaurantMemberships.length === 0) {
      setActiveRestaurantIdState(null);
      return;
    }
    const stored =
      typeof window !== 'undefined' ? window.localStorage.getItem(ACTIVE_RESTAURANT_STORAGE_KEY) : null;
    const stillValid = stored && user.restaurantMemberships.some((m) => m.restaurantId === stored);
    setActiveRestaurantIdState(stillValid ? stored : user.restaurantMemberships[0]!.restaurantId);
  }, [user]);

  const setActiveRestaurantId = useCallback((id: string) => {
    setActiveRestaurantIdState(id);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ACTIVE_RESTAURANT_STORAGE_KEY, id);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, refresh, logout, activeRestaurantId, setActiveRestaurantId }),
    [user, loading, refresh, logout, activeRestaurantId, setActiveRestaurantId],
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
