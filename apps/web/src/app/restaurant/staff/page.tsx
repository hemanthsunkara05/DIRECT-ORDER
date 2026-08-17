'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, staffApi, type StaffMember } from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';
import { Button } from '@/components/ui/Button';

export default function StaffPage() {
  return (
    <ProtectedRoute>
      <StaffManagement />
    </ProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

function StaffManagement() {
  const { user, activeRestaurantId } = useSession();
  const activeMembership = user?.restaurantMemberships.find(
    (m) => m.restaurantId === activeRestaurantId,
  );
  // Same fallback as restaurant/profile/page.tsx: prefer the switcher's
  // active restaurant, but only when this principal manages it — a
  // STAFF-only active selection falls back to a restaurant they can
  // actually administer staff for.
  const restaurantId =
    activeMembership && activeMembership.role !== 'STAFF'
      ? activeMembership.restaurantId
      : user?.restaurantMemberships.find((m) => m.role !== 'STAFF')?.restaurantId;

  const [members, setMembers] = useState<StaffMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!restaurantId) return;
    try {
      setMembers(await staffApi.list(restaurantId));
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!user || !restaurantId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-ink-500">You don&apos;t manage a restaurant.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-8 p-8" style={{ background: 'var(--bg)' }}>
      <h1 className="text-xl font-bold text-ink-900">Staff</h1>

      {error && <p className="text-sm font-medium text-error">{error}</p>}

      <StaffList
        members={members}
        restaurantId={restaurantId}
        onChanged={() => void load()}
        currentUserId={user.id}
      />
      <InviteForm restaurantId={restaurantId} onInvited={() => void load()} />
    </main>
  );
}

function StaffList({
  members,
  restaurantId,
  onChanged,
  currentUserId,
}: {
  members: StaffMember[] | null;
  restaurantId: string;
  onChanged: () => void;
  currentUserId: string;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRoleChange(staffId: string, role: 'STAFF' | 'MANAGER' | 'OWNER') {
    setError(null);
    setBusyId(staffId);
    try {
      await staffApi.changeRole(staffId, role, restaurantId);
      onChanged();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDisable(staffId: string) {
    setError(null);
    setBusyId(staffId);
    try {
      await staffApi.disable(staffId, restaurantId);
      onChanged();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusyId(null);
    }
  }

  if (!members) {
    return <p className="text-sm text-ink-500">Loading…</p>;
  }

  // Visible in the UI, not just enforced server-side (the report's own
  // named gap: "the demote/disable action on the sole remaining owner
  // should be disabled with an explanation, not just fail on click").
  const activeOwnerCount = members.filter((m) => m.role === 'OWNER' && m.status === 'ACTIVE').length;

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-sm font-medium text-error">{error}</p>}
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-ink-200 text-xs text-ink-400">
            <th className="py-2 font-medium">Name</th>
            <th className="font-medium">Role</th>
            <th className="font-medium">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => {
            const isSoleActiveOwner = m.role === 'OWNER' && m.status === 'ACTIVE' && activeOwnerCount === 1;
            const soleOwnerTitle = isSoleActiveOwner
              ? 'This restaurant must always have at least one active owner.'
              : undefined;
            return (
              <tr key={m.id} className="border-b border-dashed border-ink-200">
                <td className="py-2">
                  <p className="font-medium text-ink-900">{m.user.fullName}</p>
                  <p className="text-xs text-ink-400">{m.user.email}</p>
                </td>
                <td>
                  <select
                    value={m.role}
                    disabled={busyId === m.id || m.user.id === currentUserId || isSoleActiveOwner}
                    title={soleOwnerTitle}
                    onChange={(e) =>
                      void handleRoleChange(m.id, e.target.value as 'STAFF' | 'MANAGER' | 'OWNER')
                    }
                    className="input"
                  >
                    <option value="STAFF">Staff</option>
                    <option value="MANAGER">Manager</option>
                    <option value="OWNER">Owner</option>
                  </select>
                </td>
                <td className="text-ink-700">{m.status}</td>
                <td>
                  {m.status === 'ACTIVE' && (
                    <button
                      type="button"
                      disabled={busyId === m.id || isSoleActiveOwner}
                      title={soleOwnerTitle}
                      onClick={() => void handleDisable(m.id)}
                      className="text-xs font-semibold text-error underline disabled:cursor-not-allowed disabled:text-ink-400 disabled:no-underline"
                    >
                      Disable
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function InviteForm({ restaurantId, onInvited }: { restaurantId: string; onInvited: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'STAFF' | 'MANAGER' | 'OWNER'>('STAFF');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      await staffApi.invite({ email, role }, restaurantId);
      setMessage(`Invited ${email}.`);
      setEmail('');
      onInvited();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex flex-col gap-4 border-t border-ink-200 pt-6"
    >
      <h2 className="text-sm font-bold text-ink-900">Invite staff</h2>
      <div className="flex gap-3">
        <input
          type="email"
          required
          placeholder="colleague@restaurant.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="input flex-1"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as 'STAFF' | 'MANAGER' | 'OWNER')}
          className="input w-auto shrink-0"
        >
          <option value="STAFF">Staff</option>
          <option value="MANAGER">Manager</option>
          <option value="OWNER">Owner</option>
        </select>
        <Button type="submit" disabled={submitting} loading={submitting}>
          Invite
        </Button>
      </div>
      {message && <p className="text-sm text-ink-700">{message}</p>}
      {error && <p className="text-sm font-medium text-error">{error}</p>}
    </form>
  );
}
