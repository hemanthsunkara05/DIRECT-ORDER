'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LogOut, Menu, X } from 'lucide-react';
import { useSession } from '@/lib/auth/session-context';

const NAV_ITEMS = [
  { n: '1', label: 'Overview', href: '/admin' },
  { n: '2', label: 'Restaurants', href: '/admin/restaurants' },
  { n: '3', label: 'Approvals', href: '/admin/approvals' },
  { n: '4', label: 'Prospects', href: '/admin/prospects' },
  { n: '5', label: 'Orders & payments', href: '/admin/orders' },
  { n: '6', label: 'Audit log', href: '/admin/audit' },
  { n: '7', label: 'Support', href: '/admin/support' },
];

function initials(email: string | null): string {
  if (!email) return '?';
  return email.slice(0, 2).toUpperCase();
}

/**
 * The 224px admin sidebar, verified against AdminSidebar.dc.html — same
 * numbered-nav-item + identity-footer shape, extended with Approvals
 * and Prospects (Phase 21a additions the mockup predates). The mockup's
 * footer shows an admin's email + role ("SUPERADMIN"); `/auth/me`
 * doesn't expose the caller's admin role to the frontend today (only
 * restaurant memberships), so the role line is omitted here rather than
 * faked — email alone is real, session-backed identity.
 *
 * Below the `lg` breakpoint this becomes a slide-in drawer behind a
 * hamburger toggle, matching RestaurantSidebar's identical mobile
 * pattern — see that component's doc comment for the full reasoning.
 */
export function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  async function handleLogout() {
    await logout();
    router.push('/admin/login');
  }

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
        className={`fixed inset-y-0 left-0 z-40 flex w-[224px] shrink-0 -translate-x-full flex-col overflow-y-auto bg-ink-900 text-white transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          mobileOpen ? 'translate-x-0' : ''
        }`}
        style={{ minHeight: '100vh' }}
      >
        <div className="hidden border-b border-ink-800 px-[18px] pb-4 pt-5 lg:block">
          <div
            className="font-display text-[17px] font-extrabold"
            style={{ letterSpacing: 'var(--ls-display)' }}
          >
            DirectOrder
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-400">
            Admin console
          </div>
        </div>
        <nav className="flex flex-1 flex-col gap-px px-2.5 py-3">
          {NAV_ITEMS.map((item) => {
            // "/admin" (Overview) is a prefix of every other admin route
            // ("/admin/restaurants", "/admin/orders", ...), so it needs an
            // exact match only — every other item still matches its own
            // sub-routes too (e.g. "/admin/restaurants/:id/edit" should
            // still highlight "Restaurants"). Without this, Overview lit
            // up as active on literally every admin page, alongside
            // whichever page was actually open.
            const isActive =
              item.href === '/admin'
                ? pathname === '/admin'
                : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2 rounded-ctrl px-2.5 py-2 text-[13.5px] font-semibold ${
                  isActive ? 'bg-white/10 text-white' : 'text-ink-300 hover:bg-white/5'
                }`}
              >
                <span className="w-3.5 font-mono text-[10px] text-ink-500">{item.n}</span>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2 border-t border-ink-800 px-[18px] py-3.5">
          <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-ink-700 text-[11px] font-bold">
            {initials(user?.email ?? null)}
          </div>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold">{user?.email ?? 'Admin'}</span>
          <button
            type="button"
            onClick={() => void handleLogout()}
            aria-label="Log out"
            title="Log out"
            className="shrink-0 rounded-ctrl p-1.5 text-ink-400 hover:bg-white/10 hover:text-white"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </aside>
    </>
  );
}
