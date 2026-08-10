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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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

  return (json as { data: T }).data;
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
