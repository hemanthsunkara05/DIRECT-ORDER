import { SetMetadata } from '@nestjs/common';

export const SKIP_CSRF_KEY = 'skipCsrf';

/**
 * Exempts a route from CsrfGuard — for webhook endpoints only
 * (docs/09-security.md §15.7: "Webhook endpoints are exempt — no
 * cookies, signature-authenticated"). None exist yet (Phase 9+); this
 * decorator exists now so CsrfGuard's global registration doesn't need
 * to change when they arrive.
 */
export function SkipCsrf(): MethodDecorator {
  return SetMetadata(SKIP_CSRF_KEY, true);
}
