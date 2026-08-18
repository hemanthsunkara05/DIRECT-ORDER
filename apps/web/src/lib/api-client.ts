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

/**
 * The write shape `PATCH /restaurant/profile`'s `address` field actually
 * accepts (`UpsertAddressDto`, apps/api) — optional fields are `.optional()`
 * (undefined-only), not `.nullable()`, so `null` 422s with "Expected
 * string, received null". Distinct from `RestaurantAddress` (the READ
 * shape, where these fields really are `string | null` once persisted)
 * so a caller can't accidentally satisfy the write type by passing `null`.
 */
export interface RestaurantAddressInput {
  line1: string;
  line2?: string;
  locality?: string;
  city: string;
  state: string;
  postalCode: string;
  latitude?: number;
  longitude?: number;
  landmark?: string;
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
  submittedAt: string | null;
  decidedAt: string | null;
  rejectionReason: string | null;
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
      address: RestaurantAddressInput;
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

  /** Claims an unclaimed outreach-batch preview listing — see restaurants.controller.ts's `claim`. */
  claim: (slug: string) =>
    post<{ id: string; slug: string; status: string; onboardingStatus: string }>(
      '/restaurants/claim',
      { slug },
    ),
};

/** Phase 22 — recent Direct-Order admin edits to this restaurant. Deliberately just action + timestamp: no admin identity, no diff. */
export interface RestaurantActivityEntry {
  id: string;
  action: string;
  reason: string | null;
  createdAt: string;
}

export const restaurantActivityApi = {
  list: (restaurantId?: string) =>
    request<RestaurantActivityEntry[]>('/restaurant/activity', {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),
};

// ── Promotions (Phase 14) ──────────────────────────────────────────────

export interface Promotion {
  id: string;
  restaurantId: string | null;
  code: string;
  name: string;
  type: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_DELIVERY';
  value: number;
  minOrderMinor: string | null;
  maxDiscountMinor: string | null;
  startsAt: string | null;
  endsAt: string | null;
  usageLimitTotal: number | null;
  usageLimitPerCustomer: number | null;
  firstOrderOnly: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface PromotionCreateInput {
  code: string;
  name: string;
  type: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_DELIVERY';
  value: number;
  minOrderMinor?: string;
  maxDiscountMinor?: string;
  usageLimitTotal?: number;
  usageLimitPerCustomer?: number;
  firstOrderOnly?: boolean;
}

export const promotionsApi = {
  list: (restaurantId?: string) =>
    request<Promotion[]>('/restaurant/promotions', {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),

  create: (input: PromotionCreateInput, restaurantId?: string) =>
    request<Promotion>('/restaurant/promotions', {
      method: 'POST',
      body: JSON.stringify(input),
      ...restaurantHeaders(restaurantId),
    }),

  setActive: (id: string, isActive: boolean, restaurantId?: string) =>
    request<Promotion>(`/restaurant/promotions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
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
  | { code: 'BELOW_MINIMUM_ORDER'; minimumMinor: string; subtotalMinor: string }
  | { code: 'COUPON_INVALID' }
  | { code: 'COUPON_EXHAUSTED' };

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
    couponCode?: string;
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
  delivery: {
    status: string;
    courierName: string | null;
    courierPhone: string | null;
    trackingUrl: string | null;
    estimatedDeliveryAt: string | null;
  } | null;
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
      couponCode?: string;
      redeemLoyaltyPoints?: number;
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

  /** Phase 15 — only a DELIVERED order's own guest token can submit one. */
  submitReview: (orderNumber: string, token: string, rating: number, body?: string) =>
    post<{ id: string; rating: number; status: string }>(`/public/orders/${orderNumber}/review`, {
      token,
      rating,
      body,
    }),
};

// ── Reviews (Phase 15) ───────────────────────────────────────────────

export interface PublicReview {
  id: string;
  rating: number;
  body: string | null;
  authorFirstName: string;
  createdAt: string;
}

export interface OwnReview {
  id: string;
  orderId: string;
  rating: number;
  body: string | null;
  status: 'PENDING_REVIEW' | 'PUBLISHED' | 'HIDDEN' | 'REMOVED';
  createdAt: string;
}

export const reviewsApi = {
  listPublic: (slug: string) => get<PublicReview[]>(`/public/restaurants/${slug}/reviews`),

  listOwn: (restaurantId?: string) =>
    request<OwnReview[]>('/restaurant/reviews', {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),

  respond: (reviewId: string, body: string, restaurantId?: string) =>
    request<{ id: string; reviewId: string; body: string }>(
      `/restaurant/reviews/${reviewId}/response`,
      { method: 'POST', body: JSON.stringify({ body }), ...restaurantHeaders(restaurantId) },
    ),
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
  delivery: {
    status: string;
    provider: string;
    providerDeliveryId: string | null;
    courierName: string | null;
    courierPhone: string | null;
    trackingUrl: string | null;
    quotedFeeMinor: string | null;
    actualFeeMinor: string | null;
    attemptCount: number;
    estimatedPickupAt: string | null;
    estimatedDeliveryAt: string | null;
    pickedUpAt: string | null;
    deliveredAt: string | null;
    failureReason: string | null;
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

// ── Notifications (Phase 12) ──────────────────────────────────────────

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export type NotificationCategory = 'SECURITY' | 'TRANSACTIONAL' | 'ACCOUNT' | 'MARKETING';
export type NotificationChannel = 'IN_APP' | 'SMS' | 'WHATSAPP' | 'EMAIL';

export interface NotificationPreferenceRow {
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
  disableable: boolean;
}

/**
 * `/me/notifications*` (docs/04-api-specification.md §8.7, Phase 12).
 * Every recipient here is the authenticated restaurant user — there is
 * no customer-facing notification centre yet (AMB-2: guest checkout is
 * still the pilot default, so no registered customer session exists to
 * authenticate one against).
 */
export const notificationsApi = {
  list: (params: { cursor?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.cursor) query.set('cursor', params.cursor);
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    return requestPage<NotificationItem>(`/me/notifications${qs ? `?${qs}` : ''}`, {
      method: 'GET',
    });
  },

  unreadCount: () =>
    request<{ count: number }>('/me/notifications/unread-count', { method: 'GET' }),

  markRead: (id: string) => post<{ read: boolean }>(`/me/notifications/${id}/read`, {}),

  markAllRead: () => post<{ updated: number }>('/me/notifications/read-all', {}),

  listPreferences: () =>
    request<{ preferences: NotificationPreferenceRow[] }>('/me/notification-preferences', {
      method: 'GET',
    }),

  updatePreference: (input: {
    category: NotificationCategory;
    channel: NotificationChannel;
    enabled: boolean;
  }) =>
    request<{ category: string; channel: string; enabled: boolean }>(
      '/me/notification-preferences',
      {
        method: 'PATCH',
        body: JSON.stringify(input),
      },
    ),
};

// ── MFA (Phase 13) ─────────────────────────────────────────────────

export const mfaApi = {
  enroll: () => post<{ secret: string; otpauthUri: string }>('/auth/mfa/enroll', {}),
  confirmEnrollment: (code: string) =>
    post<{ status: string }>('/auth/mfa/enroll/confirm', { code }),
  verify: (code: string) => post<{ status: string }>('/auth/mfa/verify', { code }),
};

// ── Admin panel (Phase 13) ───────────────────────────────────────────

export interface AdminRestaurant {
  id: string;
  slug: string;
  name: string;
  status: 'DRAFT' | 'PENDING_APPROVAL' | 'ACTIVE' | 'SUSPENDED' | 'CLOSED' | 'REJECTED';
  orderingEnabled: boolean;
  createdAt: string;
  submittedAt: string | null;
}

export interface AdminRestaurantDetail {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: AdminRestaurant['status'];
  submittedAt: string | null;
  address: RestaurantAddress | null;
  branding: RestaurantBrandingData | null;
  menuSummary: { categoryCount: number; itemCount: number };
}

/** Phase 22 — admin-side restaurant creation. `ownerEmail`/`ownerPhone` optionally pre-claim it against an existing account; omitted, it's placeholder-owned (unclaimed), same as every other outreach listing. */
export interface AdminCreateRestaurantInput {
  name: string;
  slug?: string;
  description?: string;
  phone?: string;
  email?: string;
  timezone?: string;
  ownerEmail?: string;
  ownerPhone?: string;
  address?: RestaurantAddressInput;
  branding?: Partial<RestaurantBrandingData>;
}

export interface AdminCreatedRestaurant {
  id: string;
  slug: string;
  name: string;
  status: AdminRestaurant['status'];
  address: RestaurantAddress | null;
  branding: RestaurantBrandingData | null;
}

export interface AdminUserSummary {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string;
  status: 'ACTIVE' | 'DISABLED';
  createdAt: string;
}

export interface UnclaimedListing {
  slug: string;
  name: string;
  phone: string | null;
  city: string | null;
}

export interface AdminOrderSummary {
  id: string;
  orderNumber: string;
  restaurantId: string;
  status: string;
  customerName: string;
  payableTotalMinor: string;
  createdAt: string;
}

export interface AdminPaymentSummary {
  id: string;
  orderId: string;
  provider: string;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  status: string;
  amountMinor: string;
  capturedMinor: string;
  refundedMinor: string;
  currency: string;
  method: string | null;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  restaurantId: string | null;
  reason: string | null;
  createdAt: string;
}

function qs(params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  const s = query.toString();
  return s ? `?${s}` : '';
}

export interface DailyMetricsView {
  date: string;
  ordersPlaced: number;
  ordersCompleted: number;
  ordersCancelled: number;
  ordersRejected: number;
  grossOrderValueMinor: string;
  netOrderValueMinor: string;
  refundMinor: string;
  paymentsAttempted: number;
  paymentsSucceeded: number;
  deliveriesAttempted: number;
  deliveriesSucceeded: number;
  supportCasesOpened: number;
}

export const adminApi = {
  /** `ordersToday` (a live `orders.count()` placeholder — see PHASE_REPORTS.md's Phase 13 entry) is replaced by `metrics`, sourced from `DailyPlatformMetrics` rollups (Phase 17) — necessarily "as of yesterday", never a still-accumulating "today". */
  overview: () =>
    request<{
      restaurantsByStatus: Record<string, number>;
      activeAdmins: number;
      metrics: {
        asOfDate: string | null;
        latest: DailyMetricsView | null;
        trend: DailyMetricsView[];
      };
    }>('/admin/overview', { method: 'GET' }),

  health: () =>
    request<{
      database: { status: string; error?: string };
      redis: { status: string; error?: string };
    }>('/admin/health', { method: 'GET' }),

  restaurants: {
    list: (
      params: {
        status?: string;
        search?: string;
        cursor?: string;
        order?: 'newest' | 'oldest';
      } = {},
    ) => requestPage<AdminRestaurant>(`/admin/restaurants${qs(params)}`, { method: 'GET' }),
    /** Phase 21a — the Approval Queue's per-row decision detail (address, branding, menu summary). */
    detail: (id: string) => get<AdminRestaurantDetail>(`/admin/restaurants/${id}/detail`),
    approve: (id: string) =>
      post<{ id: string; status: string }>(`/admin/restaurants/${id}/approve`, {}),
    /** Phase 21a — requires `restaurant:reject`; mirrors `suspend()`'s reason-required shape. */
    reject: (id: string, reason: string) =>
      post<{ id: string; status: string }>(`/admin/restaurants/${id}/reject`, { reason }),
    suspend: (id: string, reason: string) =>
      post<{ id: string; status: string }>(`/admin/restaurants/${id}/suspend`, { reason }),
    reinstate: (id: string) =>
      post<{ id: string; status: string }>(`/admin/restaurants/${id}/reinstate`, {}),
    /** Outreach worklist — restaurants still owned only by the unclaimed-listing placeholder account. */
    unclaimed: () => get<UnclaimedListing[]>('/admin/restaurants/unclaimed'),

    /** Phase 22 — concierge onboarding: an admin creates a restaurant on an owner's behalf. */
    create: (input: AdminCreateRestaurantInput) =>
      post<AdminCreatedRestaurant>('/admin/restaurants', input),

    /** Phase 22 — admin-authorized profile/branding/hours edits, reusing the exact owner-side service logic. */
    content: {
      getProfile: (id: string) => get<RestaurantProfile>(`/admin/restaurants/${id}/profile`),
      updateProfile: (
        id: string,
        input: Partial<{
          name: string;
          description: string;
          phone: string;
          email: string;
          timezone: string;
          address: RestaurantAddressInput;
        }>,
      ) =>
        request<RestaurantProfile>(`/admin/restaurants/${id}/profile`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      getBranding: (id: string) =>
        get<RestaurantBrandingData | null>(`/admin/restaurants/${id}/branding`),
      updateBranding: (id: string, input: Partial<RestaurantBrandingData>) =>
        request<RestaurantBrandingData>(`/admin/restaurants/${id}/branding`, {
          method: 'PATCH',
          body: JSON.stringify(input),
        }),
      getHours: (id: string) => get<OperatingHoursRow[]>(`/admin/restaurants/${id}/hours`),
      setHours: (
        id: string,
        days: { dayOfWeek: number; opensAt: string; closesAt: string; isClosed?: boolean }[],
      ) =>
        request<OperatingHoursRow[]>(`/admin/restaurants/${id}/hours`, {
          method: 'PUT',
          body: JSON.stringify({ days }),
        }),
      /** Admin-authorized equivalent of the owner's onboarding-submit — still requires a separate approve action. */
      submitForApproval: (id: string) =>
        post<RestaurantProfile>(`/admin/restaurants/${id}/submit-for-approval`, {}),
    },

    /** Phase 22 — admin-authorized menu CRUD, restaurantId in the path (not X-Restaurant-Id). */
    menu: {
      categories: {
        list: (restaurantId: string) =>
          get<MenuCategory[]>(`/admin/restaurants/${restaurantId}/menu/categories`),
        create: (restaurantId: string, input: { name: string; description?: string }) =>
          post<MenuCategory>(`/admin/restaurants/${restaurantId}/menu/categories`, input),
        update: (
          restaurantId: string,
          categoryId: string,
          input: Partial<{ name: string; description: string | null; isActive: boolean }>,
        ) =>
          request<MenuCategory>(
            `/admin/restaurants/${restaurantId}/menu/categories/${categoryId}`,
            { method: 'PATCH', body: JSON.stringify(input) },
          ),
        archive: (restaurantId: string, categoryId: string) =>
          request<{ status: string }>(
            `/admin/restaurants/${restaurantId}/menu/categories/${categoryId}`,
            { method: 'DELETE' },
          ),
        reorder: (restaurantId: string, items: ReorderEntry[]) =>
          post<{ status: string }>(`/admin/restaurants/${restaurantId}/menu/categories/reorder`, {
            items,
          }),
      },
      items: {
        list: (restaurantId: string, categoryId?: string) =>
          get<MenuItem[]>(
            `/admin/restaurants/${restaurantId}/menu/items${categoryId ? `?categoryId=${categoryId}` : ''}`,
          ),
        create: (
          restaurantId: string,
          input: {
            categoryId: string;
            name: string;
            description?: string;
            priceMinor: string;
            imageUrl?: string;
            dietaryTag?: DietaryTag;
          },
        ) => post<MenuItem>(`/admin/restaurants/${restaurantId}/menu/items`, input),
        update: (
          restaurantId: string,
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
        ) =>
          request<MenuItem>(`/admin/restaurants/${restaurantId}/menu/items/${itemId}`, {
            method: 'PATCH',
            body: JSON.stringify(input),
          }),
        archive: (restaurantId: string, itemId: string) =>
          request<{ status: string }>(`/admin/restaurants/${restaurantId}/menu/items/${itemId}`, {
            method: 'DELETE',
          }),
        setAvailability: (restaurantId: string, itemId: string, isAvailable: boolean) =>
          request<MenuItem>(
            `/admin/restaurants/${restaurantId}/menu/items/${itemId}/availability`,
            { method: 'PATCH', body: JSON.stringify({ isAvailable }) },
          ),
        reorder: (restaurantId: string, items: ReorderEntry[]) =>
          post<{ status: string }>(`/admin/restaurants/${restaurantId}/menu/items/reorder`, {
            items,
          }),
      },
    },
  },

  users: {
    list: (params: { search?: string; cursor?: string } = {}) =>
      requestPage<AdminUserSummary>(`/admin/users${qs(params)}`, { method: 'GET' }),
    disable: (id: string) => post<{ status: string }>(`/admin/users/${id}/disable`, {}),
  },

  orders: {
    list: (params: { status?: string; restaurantId?: string; cursor?: string } = {}) =>
      requestPage<AdminOrderSummary>(`/admin/orders${qs(params)}`, { method: 'GET' }),
    cancel: (id: string, reason: string) =>
      post<{ status: string; applied: boolean }>(`/admin/orders/${id}/cancel`, { reason }),
  },

  payments: {
    list: (params: { status?: string; cursor?: string } = {}) =>
      requestPage<AdminPaymentSummary>(`/admin/payments${qs(params)}`, { method: 'GET' }),
  },

  auditLogs: {
    list: (params: { actorType?: string; entityType?: string; cursor?: string } = {}) =>
      requestPage<AuditLogEntry>(`/admin/audit-logs${qs(params)}`, { method: 'GET' }),
  },

  support: {
    list: (params: { status?: string; assignedToUserId?: string; cursor?: string } = {}) =>
      requestPage<AdminSupportCase>(`/admin/support/cases${qs(params)}`, { method: 'GET' }),
    get: (id: string) =>
      get<AdminSupportCase & { messages: AdminSupportMessage[] }>(`/admin/support/cases/${id}`),
    assign: (id: string, assignedToUserId: string) =>
      post<AdminSupportCase>(`/admin/support/cases/${id}/assign`, { assignedToUserId }),
    reply: (
      id: string,
      body: string,
      visibility: 'INTERNAL' | 'PUBLIC',
      attachments?: SupportAttachmentInput[],
    ) =>
      post<AdminSupportMessage>(`/admin/support/cases/${id}/messages`, {
        body,
        visibility,
        attachments,
      }),
    resolve: (id: string, resolutionNote: string) =>
      post<AdminSupportCase>(`/admin/support/cases/${id}/resolve`, { resolutionNote }),
    presign: (id: string, contentType: string, sizeBytes: number) =>
      post<SupportAttachmentPresign>(`/admin/support/cases/${id}/attachments/presign`, {
        contentType,
        sizeBytes,
      }),
    download: (id: string, attachmentId: string) =>
      get<{ url: string }>(`/admin/support/cases/${id}/attachments/${attachmentId}`),
  },
};

// ── Customer account, loyalty, and referrals (Phase 16) ────────────────

export interface CustomerAccount {
  id: string;
  phone: string;
  fullName: string;
  phoneVerified: boolean;
  createdAt: string;
  referralApplied: boolean;
}

export const customerAuthApi = {
  requestOtp: (phone: string) => post<{ message: string }>('/auth/customer/otp/request', { phone }),

  verifyOtp: (input: { phone: string; code: string; fullName?: string; referralCode?: string }) =>
    post<CustomerAccount>('/auth/customer/otp/verify', input),
};

export interface LoyaltyBalance {
  balancePoints: number;
  lifetimeEarned: number;
  lifetimeRedeemed: number;
  status: 'ACTIVE' | 'DISABLED';
}

export interface LoyaltyLedgerEntry {
  id: string;
  type: string;
  points: number;
  description: string | null;
  createdAt: string;
}

export interface ReferralView {
  status: 'PENDING' | 'QUALIFIED' | 'REWARDED' | 'EXPIRED' | 'INVALIDATED';
  attributedAt: string;
  qualifiedAt: string | null;
  rewardedAt: string | null;
}

export const loyaltyApi = {
  balance: () => get<LoyaltyBalance>('/me/loyalty'),

  ledger: (params: { cursor?: string } = {}) =>
    requestPage<LoyaltyLedgerEntry>(`/me/loyalty/ledger${qs(params)}`, { method: 'GET' }),

  referrals: () =>
    get<{ code: string; isActive: boolean; referrals: ReferralView[]; hasMore: boolean }>(
      '/me/referrals',
    ),
};

// ── Support cases and analytics (Phase 17) ──────────────────────────────

export interface SupportCaseSummary {
  id: string;
  caseNumber: string;
  category: 'ORDER' | 'PAYMENT' | 'DELIVERY' | 'ACCOUNT' | 'RESTAURANT' | 'OTHER';
  priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
  status:
    | 'OPEN'
    | 'ASSIGNED'
    | 'IN_PROGRESS'
    | 'WAITING_CUSTOMER'
    | 'WAITING_RESTAURANT'
    | 'WAITING_PROVIDER'
    | 'RESOLVED'
    | 'CLOSED';
  subject: string;
  description: string;
  orderId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  firstResponseAt: string | null;
  createdAt: string;
}

export interface AdminSupportCase extends SupportCaseSummary {
  customerId: string | null;
  restaurantId: string | null;
  assignedToUserId: string | null;
}

export interface SupportMessageView {
  id: string;
  authorType: 'CUSTOMER' | 'RESTAURANT' | 'AGENT' | 'SYSTEM';
  body: string;
  createdAt: string;
}

export interface AdminSupportMessage extends SupportMessageView {
  authorId: string | null;
  visibility: 'INTERNAL' | 'PUBLIC';
}

export interface SupportAttachmentInput {
  key: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface SupportAttachmentPresign {
  key: string;
  uploadUrl: string;
  expiresInSeconds: number;
}

export interface CreateSupportCaseInput {
  category: SupportCaseSummary['category'];
  subject: string;
  description: string;
  orderNumber?: string;
}

/** `/me/support/cases*` and `/restaurant/support/cases*` — same dual-scope-in-one-object shape `reviewsApi` already uses, since both sides share the identical response shapes. */
export const supportApi = {
  listMine: (params: { cursor?: string } = {}) =>
    requestPage<SupportCaseSummary>(`/me/support/cases${qs(params)}`, { method: 'GET' }),
  createMine: (input: CreateSupportCaseInput) =>
    post<SupportCaseSummary>('/me/support/cases', input),
  getMine: (id: string) =>
    get<SupportCaseSummary & { messages: SupportMessageView[] }>(`/me/support/cases/${id}`),
  replyMine: (id: string, body: string, attachments?: SupportAttachmentInput[]) =>
    post<SupportMessageView>(`/me/support/cases/${id}/messages`, { body, attachments }),
  presignMine: (id: string, contentType: string, sizeBytes: number) =>
    post<SupportAttachmentPresign>(`/me/support/cases/${id}/attachments/presign`, {
      contentType,
      sizeBytes,
    }),
  downloadMine: (id: string, attachmentId: string) =>
    get<{ url: string }>(`/me/support/cases/${id}/attachments/${attachmentId}`),

  listRestaurant: (params: { cursor?: string } = {}, restaurantId?: string) =>
    requestPage<SupportCaseSummary>(`/restaurant/support/cases${qs(params)}`, {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),
  createRestaurant: (input: CreateSupportCaseInput, restaurantId?: string) =>
    request<SupportCaseSummary>('/restaurant/support/cases', {
      method: 'POST',
      body: JSON.stringify(input),
      ...restaurantHeaders(restaurantId),
    }),
  getRestaurant: (id: string, restaurantId?: string) =>
    request<SupportCaseSummary & { messages: SupportMessageView[] }>(
      `/restaurant/support/cases/${id}`,
      {
        method: 'GET',
        ...restaurantHeaders(restaurantId),
      },
    ),
  replyRestaurant: (
    id: string,
    body: string,
    attachments?: SupportAttachmentInput[],
    restaurantId?: string,
  ) =>
    request<SupportMessageView>(`/restaurant/support/cases/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body, attachments }),
      ...restaurantHeaders(restaurantId),
    }),
  presignRestaurant: (id: string, contentType: string, sizeBytes: number, restaurantId?: string) =>
    request<SupportAttachmentPresign>(`/restaurant/support/cases/${id}/attachments/presign`, {
      method: 'POST',
      body: JSON.stringify({ contentType, sizeBytes }),
      ...restaurantHeaders(restaurantId),
    }),
  downloadRestaurant: (id: string, attachmentId: string, restaurantId?: string) =>
    request<{ url: string }>(`/restaurant/support/cases/${id}/attachments/${attachmentId}`, {
      method: 'GET',
      ...restaurantHeaders(restaurantId),
    }),
};

export interface RestaurantDailyMetrics {
  date: string;
  ordersPlaced: number;
  ordersCompleted: number;
  ordersCancelled: number;
  ordersRejected: number;
  grossOrderValueMinor: string;
  discountMinor: string;
  refundMinor: string;
  netOrderValueMinor: string;
  avgOrderValueMinor: string;
  avgPrepSeconds: number;
}

export interface RestaurantAnalyticsSummary {
  ordersPlaced: number;
  ordersCompleted: number;
  ordersCancelled: number;
  ordersRejected: number;
  grossOrderValueMinor: string;
  discountMinor: string;
  refundMinor: string;
  netOrderValueMinor: string;
  avgOrderValueMinor: string;
}

export const analyticsApi = {
  restaurantOverview: (params: { days?: number } = {}, restaurantId?: string) =>
    request<{ days: RestaurantDailyMetrics[]; summary: RestaurantAnalyticsSummary }>(
      `/restaurant/analytics/overview${qs({ days: params.days ? String(params.days) : undefined })}`,
      { method: 'GET', ...restaurantHeaders(restaurantId) },
    ),
};
