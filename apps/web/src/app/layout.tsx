import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Bricolage_Grotesque, Instrument_Sans, Spline_Sans_Mono } from 'next/font/google';
import { SessionProvider } from '@/lib/auth/session-context';
import './globals.css';

/**
 * Counter's three typefaces (readme.md, tokens/fonts.css), self-hosted
 * via `next/font/google` rather than the reference's own `@import` —
 * self-hosting avoids a runtime request to Google Fonts and needs no
 * CSP `font-src` relaxation (middleware.ts's `default-src 'self'`
 * already covers same-origin font files). Weight sets match the
 * reference's `@import` line exactly (400/600/700/800 for Bricolage,
 * 400/500/600 for the other two) — no extra weights bundled.
 */
const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['400', '600', '700', '800'],
  variable: '--font-bricolage',
  display: 'swap',
});
const instrument = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-instrument',
  display: 'swap',
});
const splineMono = Spline_Sans_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-spline-mono',
  display: 'swap',
});

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
    <html lang="en" className={`${bricolage.variable} ${instrument.variable} ${splineMono.variable}`}>
      <body className="min-h-screen antialiased" style={{ background: 'var(--bg)', color: 'var(--text-body)', fontFamily: 'var(--font-body)' }}>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
