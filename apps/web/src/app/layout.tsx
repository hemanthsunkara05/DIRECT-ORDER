import type { Metadata } from 'next';
import { SessionProvider } from '@/lib/auth/session-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'Direct-Order',
  description: 'Commission-free direct ordering for independent restaurants.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-slate-900 antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
