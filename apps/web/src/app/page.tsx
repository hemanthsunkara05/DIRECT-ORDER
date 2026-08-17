import Link from 'next/link';

/**
 * Root landing page. Direct-Order is deliberately not a cross-restaurant
 * marketplace (that's the Layer 1 vs Layer 2 distinction resolved in
 * IMPLEMENTATION_HANDOFF.md — no public "browse all restaurants" search
 * exists) — each restaurant is reached through its own branded ordering
 * link (`/r/:slug`), never discovered from here. This page is a minimal
 * "start here" surface: what the platform is, plus the staff/admin login
 * entry points. It replaces the Phase 1 placeholder ("the customer ordering
 * experience is not built yet"), which was never updated after the real
 * ordering experience shipped in Phase 7 and sat stale through 19 more
 * phases of development.
 */
export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-8 text-center">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">Direct-Order</h1>
        <p className="max-w-md text-sm text-slate-500">
          Commission-free direct ordering for independent restaurants. Each restaurant has its own
          branded ordering link — there is no cross-restaurant marketplace here by design.
        </p>
      </div>

      <div className="flex gap-6 text-sm">
        <Link href="/login" className="text-slate-500 underline hover:text-slate-700">
          Restaurant staff login
        </Link>
        <Link href="/admin/login" className="text-slate-500 underline hover:text-slate-700">
          Admin login
        </Link>
      </div>
    </main>
  );
}
