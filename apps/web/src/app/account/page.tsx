'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';

export default function AccountPage() {
  return (
    <ProtectedRoute>
      <AccountDetails />
    </ProtectedRoute>
  );
}

function AccountDetails() {
  const { user, logout, setActiveRestaurantId } = useSession();
  const router = useRouter();

  if (!user) return null; // ProtectedRoute guarantees this, but keeps the type narrow below.

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  function goToDashboard(restaurantId: string) {
    setActiveRestaurantId(restaurantId);
    router.push('/restaurant/orders');
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8" style={{ background: 'var(--bg)' }}>
      <h1 className="text-xl font-bold text-ink-900">Your account</h1>
      <dl className="flex flex-col gap-2 text-sm">
        <Row label="Name" value={user.fullName} />
        <Row label="Email" value={user.email ?? '—'} />
        <Row label="Email verified" value={user.emailVerified ? 'Yes' : 'No'} />
      </dl>

      <div>
        <h2 className="text-sm font-bold text-ink-900">Your restaurants</h2>
        {user.restaurantMemberships.length === 0 ? (
          <Card className="mt-2 p-4">
            <EmptyState
              message="You don't manage a restaurant yet."
              actionLabel="Create a restaurant"
              onAction={() => router.push('/onboarding')}
            />
          </Card>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {user.restaurantMemberships.map((m) => (
              <li key={m.restaurantId}>
                <Card className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <p className="font-medium text-ink-900">{m.restaurantName}</p>
                    <p className="text-xs text-ink-400">
                      {m.role} · {m.onboardingStatus === 'COMPLETED' ? 'Onboarded' : 'Setup incomplete'}
                    </p>
                  </div>
                  {m.onboardingStatus !== 'COMPLETED' ? (
                    <Link href="/onboarding" className="text-xs font-semibold text-brand-600 underline">
                      Continue setup
                    </Link>
                  ) : (
                    <Button variant="secondary" onClick={() => goToDashboard(m.restaurantId)}>
                      Go to dashboard
                    </Button>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Button onClick={() => void handleLogout()}>Log out</Button>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-ink-200 py-2">
      <dt className="text-ink-500">{label}</dt>
      <dd className="font-medium text-ink-900">{value}</dd>
    </div>
  );
}
