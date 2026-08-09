/**
 * Placeholder root page for Phase 1 (Foundation). Proves the Next.js
 * app builds, renders, and picks up Tailwind — no business feature
 * lives here. The real public ordering page arrives at
 * `(public)/r/[slug]` in Phase 7 (PRODUCT/docs/13-implementation-phases.md).
 */
export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-2xl font-semibold">Direct-Order</h1>
      <p className="text-sm text-slate-500">
        Foundation phase — the customer ordering experience is not built yet.
      </p>
    </main>
  );
}
