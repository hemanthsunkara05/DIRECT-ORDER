'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
 */
export function AdminSidebar() {
  const pathname = usePathname();
  const { user } = useSession();

  return (
    <aside className="flex w-[224px] shrink-0 flex-col bg-ink-900 text-white" style={{ minHeight: '100vh' }}>
      <div className="border-b border-ink-800 px-[18px] pb-4 pt-5">
        <div className="font-display text-[17px] font-extrabold" style={{ letterSpacing: 'var(--ls-display)' }}>
          DirectOrder
        </div>
        <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-400">
          Admin console
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-px px-2.5 py-3">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
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
        <span className="truncate text-xs font-semibold">{user?.email ?? 'Admin'}</span>
      </div>
    </aside>
  );
}
