'use client';

import { useRouter } from 'next/navigation';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';

export default function AccountPage() {
  return (
    <ProtectedRoute>
      <AccountDetails />
    </ProtectedRoute>
  );
}

function AccountDetails() {
  const { user, logout } = useSession();
  const router = useRouter();

  if (!user) return null; // ProtectedRoute guarantees this, but keeps the type narrow below.

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <h1 className="text-xl font-semibold">Your account</h1>
      <dl className="flex flex-col gap-2 text-sm">
        <Row label="Name" value={user.fullName} />
        <Row label="Email" value={user.email ?? '—'} />
        <Row label="Email verified" value={user.emailVerified ? 'Yes' : 'No'} />
      </dl>
      <button type="button" onClick={() => void handleLogout()} className="btn-primary">
        Log out
      </button>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-slate-100 py-2">
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
