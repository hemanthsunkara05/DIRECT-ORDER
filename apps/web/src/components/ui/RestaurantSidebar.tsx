'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ChevronDown, LogOut, Menu, X } from 'lucide-react';
import { useSession } from '@/lib/auth/session-context';

const NAV_ITEMS = [
  { key: 'orders', label: 'Live orders', href: '/restaurant/orders' },
  { key: 'history', label: 'Order history', href: '/restaurant/history' },
  { key: 'menu', label: 'Menu', href: '/restaurant/menu' },
  { key: 'hours', label: 'Hours', href: '/restaurant/hours' },
  { key: 'staff', label: 'Staff', href: '/restaurant/staff' },
  { key: 'promotions', label: 'Promotions', href: '/restaurant/promotions' },
  { key: 'analytics', label: 'Analytics', href: '/restaurant/analytics' },
  { key: 'notifications', label: 'Notifications', href: '/restaurant/notifications' },
  { key: 'reviews', label: 'Reviews', href: '/restaurant/reviews' },
  { key: 'support', label: 'Support', href: '/restaurant/support' },
  { key: 'profile', label: 'Profile', href: '/restaurant/profile' },
];

/**
 * The 236px navy sidebar every `/restaurant/*` page shares — verified
 * against the reference mockup (RestaurantSidebar.dc.html): wordmark,
 * active-highlighted nav list, a restaurant identity card at the bottom.
 * Extended with a tenant switcher (a dropdown replacing the static name)
 * for staff belonging to more than one restaurant — the mockup only
 * shows a single restaurant, but the report's own named gap ("today it's
 * a flat list of text links per restaurant" on /account) is exactly
 * this: no way to act as a different restaurant without leaving the
 * dashboard.
 *
 * Below the `lg` breakpoint this becomes a slide-in drawer behind a
 * hamburger toggle in a mobile-only top bar, instead of the fixed
 * always-visible column — a real restaurant-staff phone screen has
 * ~130px left for content otherwise. `lg:relative lg:translate-x-0`
 * restores the exact original desktop layout unchanged above that
 * breakpoint.
 */
export function RestaurantSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, activeRestaurantId, setActiveRestaurantId, logout } = useSession();
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // A nav click already navigates away — closing the drawer on route
  // change (rather than requiring a second tap on the backdrop) matches
  // how every mobile app drawer behaves.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  const memberships = user?.restaurantMemberships ?? [];
  const active = memberships.find((m) => m.restaurantId === activeRestaurantId) ?? memberships[0];

  return (
    <>
      <div className="flex items-center gap-3 bg-ink-900 px-4 py-3 text-white lg:hidden">
        <button
          type="button"
          onClick={() => setMobileOpen((open) => !open)}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          className="rounded-ctrl p-1.5 hover:bg-white/10"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
        <span
          className="font-display text-lg font-extrabold"
          style={{ letterSpacing: 'var(--ls-display)' }}
        >
          DirectOrder
        </span>
      </div>

      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[236px] shrink-0 -translate-x-full flex-col overflow-y-auto bg-ink-900 text-white transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : ''
        }`}
        style={{ minHeight: '100vh' }}
      >
        <div
          className="hidden px-4 py-[22px] font-display text-xl font-extrabold lg:block"
          style={{ letterSpacing: 'var(--ls-display)' }}
        >
          DirectOrder
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 px-4 pt-4 lg:pt-0">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.key}
                href={item.href}
                className={`rounded-ctrl px-2.5 py-2.5 text-sm font-semibold ${
                  isActive ? 'bg-white/10 text-white' : 'text-ink-300 hover:bg-white/5'
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        {active && (
          <div
            className="relative m-4 rounded-card p-3.5"
            style={{ background: 'rgba(255,255,255,.06)' }}
          >
            {memberships.length > 1 ? (
              <button
                type="button"
                onClick={() => setSwitcherOpen((open) => !open)}
                aria-expanded={switcherOpen}
                className="flex w-full items-center justify-between gap-2 text-left"
              >
                <span className="flex flex-col overflow-hidden">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400">
                    {active.role === 'STAFF'
                      ? 'Staff'
                      : active.role === 'MANAGER'
                        ? 'Manager'
                        : 'Owner'}
                  </span>
                  <span className="truncate text-sm font-semibold">{active.restaurantName}</span>
                </span>
                <ChevronDown className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
              </button>
            ) : (
              <>
                <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-400">
                  {active.restaurantName}
                </div>
                <div className="mt-1 font-mono text-xs text-ink-200">
                  order.directorder.in/r/{active.restaurantSlug}
                </div>
              </>
            )}

            {switcherOpen && memberships.length > 1 && (
              <ul className="absolute inset-x-0 bottom-full z-10 mb-1 flex flex-col gap-0.5 rounded-card bg-ink-800 p-1.5 shadow-3">
                {memberships.map((m) => (
                  <li key={m.restaurantId}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveRestaurantId(m.restaurantId);
                        setSwitcherOpen(false);
                      }}
                      className={`w-full rounded-ctrl px-2.5 py-2 text-left text-sm font-medium ${
                        m.restaurantId === activeRestaurantId
                          ? 'bg-white/10 text-white'
                          : 'text-ink-300 hover:bg-white/5'
                      }`}
                    >
                      {m.restaurantName}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={() => void handleLogout()}
          className="mx-4 mb-4 flex items-center gap-2 rounded-ctrl px-2.5 py-2 text-left text-sm font-semibold text-ink-300 hover:bg-white/5 hover:text-white"
        >
          <LogOut className="h-4 w-4" aria-hidden="true" />
          Log out
        </button>
      </aside>
    </>
  );
}
