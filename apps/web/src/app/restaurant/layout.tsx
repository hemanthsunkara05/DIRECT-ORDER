'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  restaurantApi,
  restaurantActivityApi,
  type RestaurantActivityEntry,
  type RestaurantProfile,
} from '@/lib/api-client';
import { useSession } from '@/lib/auth/session-context';
import { RestaurantSidebar } from '@/components/ui/RestaurantSidebar';

/**
 * The persistent 236px sidebar (RestaurantSidebar.dc.html) plus a
 * page-independent status banner over every `/restaurant/*` page —
 * "no silent waiting" between submitting and a decision. Deliberately
 * doesn't cover `/onboarding` (outside this route tree by design —
 * it's a one-time wizard with its own review/resubmit UI, not a
 * persistent dashboard page). Best-effort: a failed profile fetch here
 * silently omits the banner rather than blocking the page itself,
 * since every child page already does its own auth/data guarding.
 * Reads `activeRestaurantId` from the session (the sidebar's tenant
 * switcher), not the first membership — a staff member acting as a
 * different restaurant sees that restaurant's status, not their first one.
 */
export default function RestaurantLayout({ children }: { children: React.ReactNode }) {
  const { activeRestaurantId } = useSession();
  const [profile, setProfile] = useState<RestaurantProfile | null>(null);

  const load = useCallback(async () => {
    if (!activeRestaurantId) return;
    try {
      setProfile(await restaurantApi.getProfile(activeRestaurantId));
    } catch {
      // Best-effort — see doc comment above.
    }
  }, [activeRestaurantId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex" style={{ minHeight: '100vh' }}>
      <RestaurantSidebar />
      <div className="min-w-0 flex-1">
        {activeRestaurantId && profile && (
          <StatusBanner
            restaurantId={activeRestaurantId}
            profile={profile}
            onResubmitted={setProfile}
          />
        )}
        {activeRestaurantId && <AdminActivityBanner restaurantId={activeRestaurantId} />}
        {children}
      </div>
    </div>
  );
}

function StatusBanner({
  restaurantId,
  profile,
  onResubmitted,
}: {
  restaurantId: string;
  profile: RestaurantProfile;
  onResubmitted: (p: RestaurantProfile) => void;
}) {
  const router = useRouter();
  const [resubmitting, setResubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleResubmit() {
    setError(null);
    setResubmitting(true);
    try {
      onResubmitted(await restaurantApi.submitOnboarding(restaurantId));
    } catch {
      setError('Could not resubmit. Try again.');
    } finally {
      setResubmitting(false);
    }
  }

  if (profile.status === 'DRAFT') {
    return (
      <Banner tone="warn">
        <span>Finish setting up your restaurant to start accepting orders.</span>
        <button
          type="button"
          onClick={() => router.push('/onboarding')}
          className="font-semibold underline"
        >
          Finish setup
        </button>
      </Banner>
    );
  }

  if (profile.status === 'PENDING_APPROVAL') {
    return (
      <Banner tone="warn">
        <span>
          Submitted
          {profile.submittedAt ? ` on ${new Date(profile.submittedAt).toLocaleDateString()}` : ''} —
          awaiting admin approval.
        </span>
      </Banner>
    );
  }

  if (profile.status === 'REJECTED') {
    return (
      <Banner tone="error">
        <span>
          Your submission was rejected
          {profile.rejectionReason ? `: ${profile.rejectionReason}` : '.'}
        </span>
        {error && <span className="font-medium">{error}</span>}
        <button
          type="button"
          onClick={() => void handleResubmit()}
          disabled={resubmitting}
          className="font-semibold underline disabled:cursor-not-allowed"
        >
          {resubmitting ? 'Resubmitting…' : 'Resubmit for approval'}
        </button>
      </Banner>
    );
  }

  if (profile.status === 'SUSPENDED') {
    return (
      <Banner tone="error">
        <span>
          Your restaurant is suspended and not accepting new orders. Contact support for details.
        </span>
      </Banner>
    );
  }

  return null;
}

/**
 * Owner-facing "an admin changed something" surface (Phase 22, docs/06
 * BR-172) — best-effort, same as StatusBanner: a failed fetch silently
 * omits the banner. Deliberately shows action + relative time only, never
 * which admin or the raw diff (matches what GET /restaurant/activity
 * itself returns).
 */
function AdminActivityBanner({ restaurantId }: { restaurantId: string }) {
  const [entries, setEntries] = useState<RestaurantActivityEntry[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    restaurantActivityApi
      .list(restaurantId)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch(() => {
        // Best-effort — see doc comment above.
      });
    return () => {
      cancelled = true;
    };
  }, [restaurantId]);

  if (!entries || entries.length === 0) return null;

  return (
    <Banner tone="warn">
      <span>
        Direct-Order support made {entries.length} change{entries.length === 1 ? '' : 's'} to your
        listing recently.
      </span>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="font-semibold underline"
      >
        {expanded ? 'Hide details' : 'View details'}
      </button>
      {expanded && (
        <ul className="w-full text-left text-xs">
          {entries.map((e) => (
            <li key={e.id}>
              {formatActivityAction(e.action)} — {new Date(e.createdAt).toLocaleString()}
              {e.reason ? ` (${e.reason})` : ''}
            </li>
          ))}
        </ul>
      )}
    </Banner>
  );
}

function formatActivityAction(action: string): string {
  return action
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function Banner({ tone, children }: { tone: 'warn' | 'error'; children: React.ReactNode }) {
  const classes =
    tone === 'warn'
      ? 'bg-warn-100 text-warn-700 border-warn'
      : 'bg-error-100 text-error-700 border-error';
  return (
    <div
      className={`flex flex-wrap items-center justify-center gap-3 border-b px-4 py-2 text-center text-sm ${classes}`}
    >
      {children}
    </div>
  );
}
