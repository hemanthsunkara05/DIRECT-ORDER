'use client';

import { usePathname } from 'next/navigation';
import { AdminSidebar } from '@/components/ui/AdminSidebar';

/**
 * Wraps every `/admin/*` page with the persistent sidebar
 * (AdminSidebar.dc.html) — except `/admin/login` itself, which has no
 * session yet and shouldn't show nav for pages the visitor can't reach.
 * A pathname check here (rather than a route group restructure) keeps
 * every existing `/admin/*` page's file path unchanged.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/admin/login') {
    return <>{children}</>;
  }

  return (
    <div
      className="flex flex-col lg:flex-row"
      style={{ minHeight: '100vh', background: 'var(--ink-100)' }}
    >
      <AdminSidebar />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
