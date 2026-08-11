'use client';

import Link from 'next/link';

const LINKS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/restaurants', label: 'Restaurants' },
  { href: '/admin/orders', label: 'Orders' },
  { href: '/admin/audit', label: 'Audit log' },
];

export function AdminNav() {
  return (
    <nav className="mb-6 flex gap-4 border-b border-slate-200 pb-3 text-sm">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="text-slate-600 hover:text-slate-900 hover:underline"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
