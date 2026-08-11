'use client';

import Link from 'next/link';
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

      <div>
        <h2 className="text-sm font-semibold text-slate-900">Your restaurants</h2>
        {user.restaurantMemberships.length === 0 ? (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-sm text-slate-500">You don&apos;t manage a restaurant yet.</p>
            <Link href="/onboarding" className="btn-primary w-fit">
              Create a restaurant
            </Link>
          </div>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {user.restaurantMemberships.map((m) => (
              <li
                key={m.restaurantId}
                className="flex items-center justify-between border-b border-slate-100 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{m.restaurantName}</p>
                  <p className="text-xs text-slate-400">
                    {m.role} ·{' '}
                    {m.onboardingStatus === 'COMPLETED' ? 'Onboarded' : 'Setup incomplete'}
                  </p>
                </div>
                <div className="flex gap-3 text-xs">
                  {m.onboardingStatus !== 'COMPLETED' && (
                    <Link href="/onboarding" className="underline">
                      Continue setup
                    </Link>
                  )}
                  {/* Menu and Hours are visible to every role, including STAFF — availability toggling is the one STAFF-permitted action on each. */}
                  <Link href="/restaurant/menu" className="underline">
                    Menu
                  </Link>
                  <Link href="/restaurant/hours" className="underline">
                    Hours
                  </Link>
                  <Link href="/restaurant/orders" className="underline">
                    Orders
                  </Link>
                  <Link href="/restaurant/notifications" className="underline">
                    Notifications
                  </Link>
                  {(m.role === 'MANAGER' || m.role === 'OWNER') && (
                    <>
                      <Link href="/restaurant/profile" className="underline">
                        Profile
                      </Link>
                      <Link href="/restaurant/staff" className="underline">
                        Staff
                      </Link>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

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
