/**
 * Typed fetch wrapper for the Direct-Order API (docs/04-api-specification.md
 * §8.1). `credentials: 'include'` on every call is load-bearing — the
 * session lives in HttpOnly cookies the API sets (Phase 3), not in a
 * token this client reads or stores itself; without it, the browser
 * would never send those cookies to a different origin.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';
const CSRF_COOKIE = 'do_csrf_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Reads the CSRF cookie the API's `onRequest` hook sets on first
 * contact (csrf-cookie.hook.ts) — not HttpOnly, specifically so this
 * can read it and echo it back as a header on state-changing requests
 * (docs/09-security.md §15.7, double-submit cookie). `document.cookie`
 * only exists in the browser; every caller of `request()` here runs
 * client-side ('use client' components), so this is safe.
 */
function readCsrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]+)`));
  return match?.[1];
}

export interface ApiErrorDetail {
  field?: string;
  message?: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: ApiErrorDetail[];
  requestId: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorBody,
  ) {
    super(body.message);
    this.name = 'ApiError';
  }
}

export interface Pagination {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

async function fetchEnvelope<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; meta: { requestId: string; pagination?: Pagination } }> {
  const method = (init.method ?? 'GET').toUpperCase();
  const csrfToken = SAFE_METHODS.has(method) ? undefined : readCsrfToken();

  const res = await fetch(`${API_BASE_URL}/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...init.headers,
    },
  });

  const json: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const body = (json as { error?: ApiErrorBody } | null)?.error ?? {
      code: 'UNKNOWN_ERROR',
      message: 'Something went wrong. Please try again.',
      requestId: '',
    };
    throw new ApiError(res.status, body);
  }

  return json as { data: T; meta: { requestId: string; pagination?: Pagination } };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await fetchEnvelope<T>(path, init)).data;
}

/** For cursor-paginated list endpoints (docs/04-api-specification.md §8.1: `meta.pagination`) — first used by Phase 10's order queue. */
async function requestPage<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ items: T[]; pagination: Pagination }> {
  const envelope = await fetchEnvelope<T[]>(path, init);
  if (!envelope.meta.pagination) {
    throw new Error(`requestPage() called against a non-paginated endpoint: ${path}`);
  }
  return { items: envelope.data, pagination: envelope.meta.pagination };
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

export interface RestaurantMembershipSummary {
  restaurantId: string;
  restaurantName: string;
  restaurantSlug: string;
  role: 'STAFF' | 'MANAGER' | 'OWNER';
  onboardingStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
}

/** Mirrors AuthController's toPublicUser() field allowlist plus restaurantMemberships (Phase 4) — see apps/api's auth.controller.ts. */
export interface CurrentUser {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string;
  status: 'ACTIVE' | 'DISABLED';
  emailVerified: boolean;
  phoneVerified: boolean;
  createdAt: string;
  restaurantMemberships: RestaurantMembershipSummary[];
}

export type VerificationPurpose = 'EMAIL_VERIFICATION' | 'PHONE_VERIFICATION';

export const authApi = {
  register: (input: { email: string; fullName: string; password: string }) =>
    post<{ message: string }>('/auth/register', input),

  login: (input: { email: string; password: string }) => post<CurrentUser>('/auth/login', input),

  logout: () => post<{ status: string }>('/auth/logout', {}),

  refresh: () => post<{ status: string }>('/auth/refresh', {}),

  forgotPassword: (email: string) => post<{ message: string }>('/auth/password/forgot', { email }),

  resetPassword: (input: { token: string; newPassword: string }) =>
    post<{ status: string }>('/auth/password/reset', input),

  requestOtp: (input: { identifier: string; purpose: VerificationPurpose }) =>
    post<{ message: string }>('/auth/otp/request', input),

  verifyOtp: (input: { identifier: string; purpose: VerificationPurpose; code: string }) =>
    post<{ status: string }>('/auth/otp/verify', input),

  me: () => get<CurrentUser>('/auth/me'),

  acceptInvitation: (token: string) =>
    post<{ status: string; restaurantId: string }>('/auth/invitations/accept', { token }),
};

// ── Restaurants (Phase 5) ───────────────────────────────────────────

export interface RestaurantAddress {
  line1: string;
  line2: string | null;
  locality: string | null;
  city: string;
  state: string;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  landmark: string | null;
}

export interface RestaurantProfile {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  phone: string | null;
  email: string | null;
  timezone: string;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED' | 'REJECTED';
  onboardingStatus: 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
  orderingEnabled: boolean;
  createdAt: string;
  address: RestaurantAddress | null;
}

export interface RestaurantBrandingData {
  logoUrl: string | null;
  coverImageUrl: string | null;
  themePrimaryColor: string | null;
  themeAccentColor: string | null;
  tagline: string | null;
}

export interface RestaurantSettingsData {
  minOrderAmountMinor: string;
  packagingFeeMinor: string;
  deliveryFeeMode: string;
  deliveryFeeFlatMinor: string;
  acceptsOnlinePayment: boolean;
  autoAcceptOrders: boolean;
  notificationEmails: string[];
  notificationPhones: string[];
}

/** Restaurant-scoped calls attach X-Restaurant-Id when the caller belongs to more than one restaurant (docs/04-api-specification.md §8.1). */
function restaurantHeaders(restaurantId?: string): RequestInit {
  return restaurantId ? { headers: { 'X-Restaurant-Id': restaurantId } } : {};
}

export const restaurantApi = {
  create: (input: {
    name: string;
    slug?: string;
    description?: string;
    phone?: string;
    email?: string;
  }) =>
    post<{ id: string; slug: string; status: string; onboardingStatus: string }>(
      '/restaurants',
      input,
    ),

  getProfile: (restaurantId?: string) =>
    request<RestaurantProfile>('/restaurant/profile', {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),

  updateProfile: (
    input: Partial<{
      name: string;
      description: string;
      phone: string;
      email: string;
      timezone: string;
      address: RestaurantAddress;
    }>,
    restaurantId?: string,
  ) =>
    request<RestaurantProfile>('/restaurant/profile', {
      method: 'PATCH',
      body: JSON.stringify(input),
      ...restaurantHeaders(restaurantId),
    }),

  getBranding: (restaurantId?: string) =>
    request<RestaurantBrandingData | null>('/restaurant/branding', {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),

  updateBranding: (input: Partial<RestaurantBrandingData>, restaurantId?: string) =>
    request<RestaurantBrandingData>('/restaurant/branding', {
      method: 'PATCH',
      body: JSON.stringify(input),
      ...restaurantHeaders(restaurantId),
    }),

  getSettings: (restaurantId?: string) =>
    request<RestaurantSettingsData | null>('/restaurant/settings', {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),

  updateSettings: (
    // Money fields are strings (integer-paise, e.g. "20000") — the API's
    // Zod schema coerces either a JSON string or number to bigint, but a
    // string avoids ever round-tripping money through a JS number, even
    // at this boundary (packages/money's whole reason for existing).
    input: Partial<{
      minOrderAmountMinor: string;
      packagingFeeMinor: string;
      deliveryFeeMode: string;
      deliveryFeeFlatMinor: string;
      acceptsOnlinePayment: boolean;
      autoAcceptOrders: boolean;
      notificationEmails: string[];
      notificationPhones: string[];
    }>,
    restaurantId?: string,
  ) =>
    request<RestaurantSettingsData>('/restaurant/settings', {
      method: 'PATCH',
      body: JSON.stringify(input),
      ...restaurantHeaders(restaurantId),
    }),

  submitOnboarding: (restaurantId?: string) =>
    request<RestaurantProfile>('/restaurant/onboarding/submit', {
      method: 'POST',
      ...restaurantHeaders(restaurantId),
    }),
};

// ── Staff (Phase 5) ──────────────────────────────────────────────────

export interface StaffMember {
  id: string;
  role: 'STAFF' | 'MANAGER' | 'OWNER';
  status: 'ACTIVE' | 'DISABLED';
  joinedAt: string;
  user: { id: string; fullName: string; email: string | null; phone: string | null };
}

export const staffApi = {
  list: (restaurantId?: string) =>
    request<StaffMember[]>('/restaurant/staff', {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),

  invite: (input: { email: string; role: 'STAFF' | 'MANAGER' | 'OWNER' }, restaurantId?: string) =>
    request<{ id: string; email: string; role: string; status: string; expiresAt: string }>(
      '/restaurant/staff/invitations',
      { method: 'POST', body: JSON.stringify(input), ...restaurantHeaders(restaurantId) },
    ),

  changeRole: (staffId: string, role: 'STAFF' | 'MANAGER' | 'OWNER', restaurantId?: string) =>
    request<{ status: string }>(`/restaurant/staff/${staffId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
      ...restaurantHeaders(restaurantId),
    }),

  disable: (staffId: string, restaurantId?: string) =>
    request<{ status: string }>(`/restaurant/staff/${staffId}`, {
      method: 'DELETE',
      ...restaurantHeaders(restaurantId),
    }),
};

// ── Uploads (Phase 5) ────────────────────────────────────────────────

export const uploadApi = {
  presign: (input: { contentType: string; sizeBytes: number }, restaurantId?: string) =>
    request<{ key: string; uploadUrl: string; publicUrl: string; expiresInSeconds: number }>(
      '/restaurant/uploads/presign',
      { method: 'POST', body: JSON.stringify(input), ...restaurantHeaders(restaurantId) },
    ),

  verify: (input: { key: string; contentType: string }, restaurantId?: string) =>
    request<{ status: string }>('/restaurant/uploads/verify', {
      method: 'POST',
      body: JSON.stringify(input),
      ...restaurantHeaders(restaurantId),
    }),
};

// ── Menu (Phase 6) ───────────────────────────────────────────────────

export interface MenuCategory {
  id: string;
  name: string;
  description: string | null;
  displayOrder: number;
  isActive: boolean;
  archivedAt: string | null;
}

export type DietaryTag = 'VEG' | 'NON_VEG' | 'EGG' | 'UNKNOWN';

export interface MenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  // Integer paise as a string (INV-1) — never a JS number, same
  // reasoning as RestaurantSettingsData's money fields.
  priceMinor: string;
  currency: string;
  imageUrl: string | null;
  isAvailable: boolean;
  isActive: boolean;
  displayOrder: number;
  dietaryTag: DietaryTag;
  archivedAt: string | null;
}

export interface ReorderEntry {
  id: string;
  displayOrder: number;
}

export const menuApi = {
  categories: {
    list: (restaurantId?: string) =>
      request<MenuCategory[]>('/restaurant/menu/categories', {
        method: 'GET',
        ...restaurantHeaders(restaurantId),
      }),

    create: (input: { name: string; description?: string }, restaurantId?: string) =>
      request<MenuCategory>('/restaurant/menu/categories', {
        method: 'POST',
        body: JSON.stringify(input),
        ...restaurantHeaders(restaurantId),
      }),

    update: (
      categoryId: string,
      input: Partial<{ name: string; description: string | null; isActive: boolean }>,
      restaurantId?: string,
    ) =>
      request<MenuCategory>(`/restaurant/menu/categories/${categoryId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
        ...restaurantHeaders(restaurantId),
      }),

    archive: (categoryId: string, restaurantId?: string) =>
      request<{ status: string }>(`/restaurant/menu/categories/${categoryId}`, {
        method: 'DELETE',
        ...restaurantHeaders(restaurantId),
      }),

    reorder: (items: ReorderEntry[], restaurantId?: string) =>
      request<{ status: string }>('/restaurant/menu/categories/reorder', {
        method: 'POST',
        body: JSON.stringify({ items }),
        ...restaurantHeaders(restaurantId),
      }),
  },

  items: {
    list: (categoryId: string | undefined, restaurantId?: string) =>
      request<MenuItem[]>(
        `/restaurant/menu/items${categoryId ? `?categoryId=${categoryId}` : ''}`,
        { method: 'GET', ...restaurantHeaders(restaurantId) },
      ),

    create: (
      input: {
        categoryId: string;
        name: string;
        description?: string;
        priceMinor: string;
        imageUrl?: string;
        dietaryTag?: DietaryTag;
      },
      restaurantId?: string,
    ) =>
      request<MenuItem>('/restaurant/menu/items', {
        method: 'POST',
        body: JSON.stringify(input),
        ...restaurantHeaders(restaurantId),
      }),

    update: (
      itemId: string,
      input: Partial<{
        categoryId: string;
        name: string;
        description: string | null;
        priceMinor: string;
        imageUrl: string | null;
        dietaryTag: DietaryTag;
        isActive: boolean;
      }>,
      restaurantId?: string,
    ) =>
      request<MenuItem>(`/restaurant/menu/items/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
        ...restaurantHeaders(restaurantId),
      }),

    archive: (itemId: string, restaurantId?: string) =>
      request<{ status: string }>(`/restaurant/menu/items/${itemId}`, {
        method: 'DELETE',
        ...restaurantHeaders(restaurantId),
      }),

    setAvailability: (itemId: string, isAvailable: boolean, restaurantId?: string) =>
      request<MenuItem>(`/restaurant/menu/items/${itemId}/availability`, {
        method: 'PATCH',
        body: JSON.stringify({ isAvailable }),
        ...restaurantHeaders(restaurantId),
      }),

    reorder: (items: ReorderEntry[], restaurantId?: string) =>
      request<{ status: string }>('/restaurant/menu/items/reorder', {
        method: 'POST',
        body: JSON.stringify({ items }),
        ...restaurantHeaders(restaurantId),
      }),
  },
};

// ── Availability: hours, closures, ordering toggle (Phase 7) ─────────

export interface OperatingHoursRow {
  id: string;
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
}

export interface ClosurePeriod {
  id: string;
  startsAt: string;
  endsAt: string | null;
  reason: string | null;
}

export const hoursApi = {
  get: (restaurantId?: string) =>
    request<OperatingHoursRow[]>('/restaurant/hours', {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),

  set: (
    days: { dayOfWeek: number; opensAt: string; closesAt: string; isClosed?: boolean }[],
    restaurantId?: string,
  ) =>
    request<OperatingHoursRow[]>('/restaurant/hours', {
      method: 'PUT',
      body: JSON.stringify({ days }),
      ...restaurantHeaders(restaurantId),
    }),
};

export const closuresApi = {
  list: (restaurantId?: string) =>
    request<ClosurePeriod[]>('/restaurant/closures', {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),

  create: (
    input: { startsAt: string; endsAt?: string | null; reason?: string },
    restaurantId?: string,
  ) =>
    request<ClosurePeriod>('/restaurant/closures', {
      method: 'POST',
      body: JSON.stringify(input),
      ...restaurantHeaders(restaurantId),
    }),

  end: (closureId: string, restaurantId?: string) =>
    request<{ status: string }>(`/restaurant/closures/${closureId}`, {
      method: 'DELETE',
      ...restaurantHeaders(restaurantId),
    }),
};

export const availabilityApi = {
  toggle: (orderingEnabled: boolean, restaurantId?: string) =>
    request<{ orderingEnabled: boolean }>('/restaurant/availability', {
      method: 'PATCH',
      body: JSON.stringify({ orderingEnabled }),
      ...restaurantHeaders(restaurantId),
    }),
};

// ── Checkout quote (Phase 8) ──────────────────────────────────────────
// Public/unauthenticated endpoint, but called through this same
// CSRF-aware fetch wrapper like every other mutating request — the
// globally-registered CsrfGuard checks every non-GET request
// regardless of auth state (apps/api/src/platform/security/csrf.guard.ts).

export type CartIssue =
  | { code: 'RESTAURANT_UNAVAILABLE'; reason: string }
  | { code: 'ITEM_UNAVAILABLE'; itemId: string }
  | { code: 'PRICE_CHANGED'; itemId: string; oldPriceMinor: string; newPriceMinor: string }
  | { code: 'BELOW_MINIMUM_ORDER'; minimumMinor: string; subtotalMinor: string };

export interface QuoteLineItem {
  itemId: string;
  name: string;
  unitPriceMinor: string;
  quantity: number;
  lineTotalMinor: string;
}

export interface QuoteBreakdown {
  items: QuoteLineItem[];
  itemsSubtotalMinor: string;
  packagingFeeMinor: string;
  deliveryFeeMinor: string;
  platformFeeMinor: string;
  taxMinor: string;
  discountableBaseMinor: string;
  promotionDiscountMinor: string;
  loyaltyDiscountMinor: string;
  discountMinor: string;
  payableTotalMinor: string;
}

export interface QuoteResult {
  valid: boolean;
  issues: CartIssue[];
  breakdown: QuoteBreakdown;
}

export const checkoutApi = {
  quote: (input: {
    restaurantSlug: string;
    items: { itemId: string; quantity: number; unitPriceMinorAtAdd: string }[];
  }) =>
    request<QuoteResult>('/public/checkout/quote', { method: 'POST', body: JSON.stringify(input) }),
};

// ── Carts, checkout, payment, order tracking (Phase 9) ────────────────

export interface CartLine {
  itemId: string;
  quantity: number;
  unitPriceMinorAtAdd: string;
}

export const cartApi = {
  create: (input: { restaurantSlug: string; items: CartLine[] }) =>
    post<{ cartId: string; guestToken: string; expiresAt: string }>('/public/carts', input),

  validate: (cartId: string, guestToken: string) =>
    post<QuoteResult>(`/public/carts/${cartId}/validate`, { guestToken }),
};

export interface DeliveryAddressInput {
  line1: string;
  locality?: string;
  city: string;
  postalCode: string;
  latitude?: number;
  longitude?: number;
}

export interface CheckoutResponse {
  orderNumber: string;
  accessToken: string | null;
  status: string;
  payableTotalMinor: string;
  breakdown: QuoteBreakdown;
  provider: { name: string; providerOrderId: string; providerPublicKey: string } | null;
}

export interface OrderTrackingView {
  orderNumber: string;
  status: string;
  customerName: string;
  deliveryAddress: unknown;
  breakdown: QuoteBreakdown;
  payableTotalMinor: string;
  items: {
    name: string;
    description: string | null;
    unitPriceMinor: string;
    quantity: number;
    lineTotalMinor: string;
  }[];
  history: { toStatus: string; createdAt: string }[];
  paymentStatus: string | null;
  createdAt: string;
}

/**
 * `Idempotency-Key` (docs/04-api-specification.md §8.2, "client-
 * generated UUID") is generated once per checkout ATTEMPT and reused
 * across retries within that attempt — `crypto.randomUUID()` is
 * available in every browser this app targets, no polyfill needed.
 */
export const orderApi = {
  checkout: (
    input: {
      cartId: string;
      guestToken: string;
      customer: { name: string; phone: string; email?: string };
      deliveryAddress: DeliveryAddressInput;
      expectedTotalMinor?: string;
    },
    idempotencyKey: string,
  ) =>
    request<CheckoutResponse>('/public/checkout', {
      method: 'POST',
      body: JSON.stringify(input),
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  track: (orderNumber: string, token: string) =>
    get<OrderTrackingView>(`/public/orders/${orderNumber}?token=${encodeURIComponent(token)}`),

  verifyPayment: (orderNumber: string, token: string, providerPaymentId?: string) =>
    post<{ paymentStatus: string; orderStatus: string }>(
      `/public/orders/${orderNumber}/verify-payment`,
      { token, providerPaymentId },
    ),

  /** Dev/test-mode only (`PAYMENT_PROVIDER=mock`) — 404s otherwise. Stands in for completing Razorpay Checkout. */
  simulatePayment: (orderNumber: string, token: string, outcome: 'CAPTURED' | 'FAILED') =>
    post<{ providerPaymentId: string | null }>(`/public/orders/${orderNumber}/simulate-payment`, {
      token,
      outcome,
    }),
};

// ── Restaurant order management (Phase 10) ────────────────────────────

export interface RestaurantOrderSummary {
  id: string;
  orderNumber: string;
  status: string;
  customerName: string;
  payableTotalMinor: string;
  createdAt: string;
  placedAt: string | null;
}

export interface RestaurantOrderDetail {
  id: string;
  orderNumber: string;
  status: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress: unknown;
  itemsSubtotalMinor: string;
  packagingFeeMinor: string;
  deliveryFeeMinor: string;
  platformFeeMinor: string;
  taxMinor: string;
  discountMinor: string;
  payableTotalMinor: string;
  rejectionReason: string | null;
  cancellationReason: string | null;
  createdAt: string;
  placedAt: string | null;
  acceptedAt: string | null;
  readyAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  items: {
    id: string;
    nameSnapshot: string;
    descriptionSnapshot: string | null;
    unitPriceMinorSnapshot: string;
    quantity: number;
    lineTotalMinor: string;
  }[];
  history: {
    fromStatus: string | null;
    toStatus: string;
    actorType: string;
    reason: string | null;
    createdAt: string;
  }[];
  payment: {
    status: string;
    amountMinor: string;
    capturedMinor: string;
    refundedMinor: string;
    method: string | null;
  } | null;
}

export interface TransitionResult {
  status: string;
  applied: boolean;
}

/**
 * Every mutating call here sends a fresh `Idempotency-Key`
 * (`crypto.randomUUID()`) — required by the API (docs/04 §8.5) even
 * though the underlying transition is already safely idempotent by
 * target state; see OrderStateService's own doc comment. `restaurantId`
 * is only needed when the caller belongs to more than one restaurant
 * (`restaurantHeaders()` omits the header entirely otherwise, and
 * `AuthorizationGuard` resolves the sole active membership implicitly).
 */
export const restaurantOrdersApi = {
  list: (
    params: { status?: string[]; cursor?: string; limit?: number } = {},
    restaurantId?: string,
  ) => {
    const query = new URLSearchParams();
    if (params.status?.length) query.set('status', params.status.join(','));
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return requestPage<RestaurantOrderSummary>(`/restaurant/orders${qs ? `?${qs}` : ''}`, {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    });
  },

  detail: (orderId: string, restaurantId?: string) =>
    request<RestaurantOrderDetail>(`/restaurant/orders/${orderId}`, {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),

  accept: (orderId: string, restaurantId?: string) =>
    request<TransitionResult>(`/restaurant/orders/${orderId}/accept`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      ...restaurantHeaders(restaurantId),
    }),

  reject: (orderId: string, reason: string, restaurantId?: string) =>
    request<TransitionResult>(`/restaurant/orders/${orderId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      ...restaurantHeaders(restaurantId),
    }),

  preparing: (orderId: string, restaurantId?: string) =>
    request<TransitionResult>(`/restaurant/orders/${orderId}/preparing`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      ...restaurantHeaders(restaurantId),
    }),

  ready: (orderId: string, restaurantId?: string) =>
    request<TransitionResult>(`/restaurant/orders/${orderId}/ready`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      ...restaurantHeaders(restaurantId),
    }),

  /**
   * Builds the SSE URL directly rather than wrapping it in a helper
   * that constructs `EventSource` itself — `useOrderStream` needs to
   * own the `EventSource` instance to manage manual reconnection with
   * a resume cursor (see that hook for why native auto-reconnect isn't
   * enough on its own).
   *
   * No `X-Restaurant-Id` disambiguation is possible here — `EventSource`
   * cannot set custom request headers, only cookies (`withCredentials`
   * covers the session, nothing else), and `AuthorizationGuard` only
   * ever reads that header, never a query param, by design (it's
   * security-sensitive, heavily-tested infrastructure from Phase 4 this
   * phase deliberately didn't touch for a narrow SSE convenience). A
   * staff member belonging to more than one restaurant therefore can't
   * use this stream at all — `useOrderStream` checks for that case
   * up front and skips straight to the 15s polling fallback, which
   * goes through the normal header-carrying `request()` path and works
   * for every account shape.
   */
  streamUrl: (lastEventId: string | undefined): string => {
    const query = new URLSearchParams();
    if (lastEventId) query.set('lastEventId', lastEventId);
    const qs = query.toString();
    return `${API_BASE_URL}/api/v1/restaurant/orders/stream${qs ? `?${qs}` : ''}`;
  },
};
