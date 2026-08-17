'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  availabilityApi,
  closuresApi,
  hoursApi,
  restaurantApi,
  type ClosurePeriod,
  type OperatingHoursRow,
} from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface DayForm {
  isClosed: boolean;
  opensAt: string;
  closesAt: string;
}

function defaultDayForm(): DayForm {
  return { isClosed: true, opensAt: '09:00', closesAt: '21:00' };
}

export default function HoursPage() {
  return (
    <ProtectedRoute>
      <HoursManagement />
    </ProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

function HoursManagement() {
  const { user, activeRestaurantId } = useSession();
  const membership = user?.restaurantMemberships.find((m) => m.restaurantId === activeRestaurantId);
  const restaurantId = activeRestaurantId ?? undefined;
  const canManageHours = membership?.role === 'MANAGER' || membership?.role === 'OWNER';

  if (!user || !restaurantId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-slate-500">You don&apos;t manage a restaurant.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-10 p-8">
      <h1 className="text-xl font-semibold">Hours &amp; availability</h1>
      <AvailabilityToggle restaurantId={restaurantId} />
      {canManageHours && <WeeklyHours restaurantId={restaurantId} />}
      {canManageHours && <Closures restaurantId={restaurantId} />}
    </main>
  );
}

/**
 * Deliberately non-optimistic, same reasoning as the menu availability
 * toggle (restaurant/menu/page.tsx): the switch only ever reflects the
 * last server-confirmed value, so a failed toggle can't leave the UI
 * showing an unsaved state.
 */
function AvailabilityToggle({ restaurantId }: { restaurantId: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // There is no dedicated GET /restaurant/availability (only PATCH) —
  // orderingEnabled already comes back on the profile every role can
  // read (restaurant:read, STAFF included), so that's the source of the
  // initial value here.
  const load = useCallback(async () => {
    try {
      const profile = await restaurantApi.getProfile(restaurantId);
      setEnabled(profile.orderingEnabled);
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleToggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await availabilityApi.toggle(next, restaurantId);
      setEnabled(res.orderingEnabled);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold text-slate-900">Accepting orders</h2>
      <p className="text-xs text-slate-500">
        This switch alone can never make the restaurant orderable while the platform has it
        suspended — operating hours and platform status are checked first.
      </p>
      <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
        <input
          type="checkbox"
          checked={enabled ?? false}
          disabled={busy}
          onChange={(e) => void handleToggle(e.target.checked)}
        />
        Ordering enabled
      </label>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </section>
  );
}

function WeeklyHours({ restaurantId }: { restaurantId: string }) {
  const [days, setDays] = useState<DayForm[]>(() =>
    Array.from({ length: 7 }, () => defaultDayForm()),
  );
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    hoursApi
      .get(restaurantId)
      .then((rows: OperatingHoursRow[]) => {
        const next = Array.from({ length: 7 }, () => defaultDayForm());
        for (const row of rows) {
          next[row.dayOfWeek] = {
            isClosed: row.isClosed,
            opensAt: row.opensAt,
            closesAt: row.closesAt,
          };
        }
        setDays(next);
      })
      .catch((err: unknown) => setError(formatError(err)))
      .finally(() => setLoaded(true));
  }, [restaurantId]);

  function updateDay(index: number, patch: Partial<DayForm>) {
    setDays((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await hoursApi.set(
        days.map((d, dayOfWeek) => ({
          dayOfWeek,
          opensAt: d.isClosed ? '00:00' : d.opensAt,
          closesAt: d.isClosed ? '00:00' : d.closesAt,
          isClosed: d.isClosed,
        })),
        restaurantId,
      );
      setMessage('Hours saved.');
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSaving(false);
    }
  }

  if (!loaded) {
    return <p className="text-sm text-slate-500">Loading hours…</p>;
  }

  return (
    <section className="flex flex-col gap-4 border-t border-slate-200 pt-8">
      <h2 className="text-sm font-semibold text-slate-900">Weekly hours</h2>
      <p className="text-xs text-slate-500">
        One shift per day. Set closing time earlier than opening time for an overnight shift (e.g.
        22:00 → 02:00).
      </p>
      <div className="flex flex-col gap-3">
        {DAY_NAMES.map((name, index) => {
          const day = days[index]!;
          return (
            <div key={name} className="flex items-center gap-3 text-sm">
              <span className="w-24 shrink-0 font-medium">{name}</span>
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={!day.isClosed}
                  onChange={(e) => updateDay(index, { isClosed: !e.target.checked })}
                />
                Open
              </label>
              {!day.isClosed && (
                <>
                  <input
                    type="time"
                    value={day.opensAt}
                    onChange={(e) => updateDay(index, { opensAt: e.target.value })}
                    className="input w-28"
                    aria-label={`${name} opening time`}
                  />
                  <span className="text-slate-400">to</span>
                  <input
                    type="time"
                    value={day.closesAt}
                    onChange={(e) => updateDay(index, { closesAt: e.target.value })}
                    className="input w-28"
                    aria-label={`${name} closing time`}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
      {message && <p className="text-sm text-slate-600">{message}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="button"
        disabled={saving}
        onClick={() => void handleSave()}
        className="btn-primary w-fit"
      >
        {saving ? 'Saving…' : 'Save hours'}
      </button>
    </section>
  );
}

function Closures({ restaurantId }: { restaurantId: string }) {
  const [closures, setClosures] = useState<ClosurePeriod[] | null>(null);
  const [reason, setReason] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setClosures(await closuresApi.list(restaurantId));
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await closuresApi.create(
        { startsAt: new Date(startsAt).toISOString(), reason: reason || undefined },
        restaurantId,
      );
      setReason('');
      setStartsAt('');
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleEnd(closureId: string) {
    setBusy(true);
    setError(null);
    try {
      await closuresApi.end(closureId, restaurantId);
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-4 border-t border-slate-200 pt-8">
      <h2 className="text-sm font-semibold text-slate-900">Temporary closures</h2>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!closures ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : closures.length === 0 ? (
        <p className="text-sm text-slate-500">No closures on record.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {closures.map((closure) => {
            const active = !closure.endsAt || new Date(closure.endsAt) > new Date();
            return (
              <li key={closure.id} className="flex items-center justify-between text-sm">
                <div>
                  <p>{new Date(closure.startsAt).toLocaleString()}</p>
                  {closure.reason && <p className="text-xs text-slate-500">{closure.reason}</p>}
                </div>
                {active ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleEnd(closure.id)}
                    className="text-xs text-red-600 underline"
                  >
                    End now
                  </button>
                ) : (
                  <span className="text-xs text-slate-400">Ended</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form
        onSubmit={(e) => void handleCreate(e)}
        className="flex flex-col gap-3 border-t border-slate-100 pt-4"
      >
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Starts at
          <input
            type="datetime-local"
            required
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            className="input"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
          Reason (optional)
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="input"
            placeholder="Gas leak, family emergency, ..."
          />
        </label>
        <button type="submit" disabled={busy} className="btn-primary w-fit">
          Start closure
        </button>
      </form>
    </section>
  );
}
