'use client';

/**
 * Route-segment error boundary for the public storefront. `fetchPublic()`
 * (lib/public-api.ts) throws on any non-404 failure — including a 502 from
 * the API cold-starting on Render's free tier — and without this boundary
 * that exception reached Next's default handler as a bare, unbranded
 * "Application error" white screen on the one page real customers actually
 * land on. This can't fix the cold start itself, only stop it from being a
 * dead end for the person trying to order food.
 */
export default function StorefrontError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-lg font-semibold">We couldn&apos;t load this restaurant</h1>
      <p className="text-sm text-slate-600">
        This usually clears up in a few seconds. Please try again.
      </p>
      <button type="button" onClick={() => reset()} className="btn-primary">
        Try again
      </button>
    </main>
  );
}
