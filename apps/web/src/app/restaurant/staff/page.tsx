'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, staffApi, type StaffMember } from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';

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
  const { user } = useSession();
  // Pilot scope: a manager/owner acts on the first restaurant they
  // manage — a user belonging to several would need a picker, not
  // built yet (no multi-restaurant owner flow exists before Phase 5).
  const restaurantId = user?.restaurantMemberships.find((m) => m.role !== 'STAFF')?.restaurantId;

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
        <p className="text-sm text-slate-500">You don&apos;t manage a restaurant.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col gap-8 p-8">
      <h1 className="text-xl font-semibold">Staff</h1>

      {error && <p className="text-sm text-red-600">{error}</p>}

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
    return <p className="text-sm text-slate-500">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {error && <p className="text-sm text-red-600">{error}</p>}
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-400">
            <th className="py-2 font-medium">Name</th>
            <th className="font-medium">Role</th>
            <th className="font-medium">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id} className="border-b border-slate-100">
              <td className="py-2">
                <p className="font-medium">{m.user.fullName}</p>
                <p className="text-xs text-slate-400">{m.user.email}</p>
              </td>
              <td>
                <select
                  value={m.role}
                  disabled={busyId === m.id || m.user.id === currentUserId}
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
              <td>{m.status}</td>
              <td>
                {m.status === 'ACTIVE' && (
                  <button
                    type="button"
                    disabled={busyId === m.id}
                    onClick={() => void handleDisable(m.id)}
                    className="text-xs text-red-600 underline"
                  >
                    Disable
                  </button>
                )}
              </td>
            </tr>
          ))}
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
      className="flex flex-col gap-4 border-t border-slate-200 pt-6"
    >
      <h2 className="text-sm font-semibold text-slate-900">Invite staff</h2>
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
          className="input"
        >
          <option value="STAFF">Staff</option>
          <option value="MANAGER">Manager</option>
          <option value="OWNER">Owner</option>
        </select>
        <button type="submit" disabled={submitting} className="btn-primary">
          {submitting ? 'Sending…' : 'Invite'}
        </button>
      </div>
      {message && <p className="text-sm text-slate-600">{message}</p>}
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}
