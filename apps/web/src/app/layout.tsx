import type { Metadata } from 'next';
import { connection } from 'next/server';
import { SessionProvider } from '@/lib/auth/session-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'Direct-Order',
  description: 'Commission-free direct ordering for independent restaurants.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // A nonce-based CSP (middleware.ts) requires every page to be dynamically
  // rendered — Next.js only has a request to read the nonce from during
  // server-side rendering, never at build time. Without this, `next build`
  // would still prerender most of this app's pages (login, signup, etc. all
  // built static per the last real build output) with no nonce baked in,
  // reproducing the exact inline-script CSP-block/blank-page bug this
  // middleware exists to fix — just in production instead of dev, and only
  // discoverable there. `connection()` opts the whole tree into dynamic
  // rendering, the officially documented fix for this exact requirement
  // (https://nextjs.org/docs/app/guides/content-security-policy).
  await connection();

  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
