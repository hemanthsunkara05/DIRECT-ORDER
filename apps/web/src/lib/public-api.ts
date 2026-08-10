/**
 * Fetch helper for the unauthenticated `/public/*` API surface
 * (docs/04-api-specification.md §8.3). Deliberately separate from
 * `api-client.ts` — that module's `request()` reads `document.cookie`
 * for the CSRF token and assumes a browser, but this one is called from
 * a React Server Component during SSR (the public restaurant page,
 * Phase 7) as well as from client components, and public GETs need
 * neither cookies nor a CSRF header at all.
 *
 * `next: { revalidate: 60 }` gives these calls Next's built-in fetch
 * cache with a 60s TTL — the frontend-side equivalent of the API
 * table's "Cached 60s" note (docs/04-api-specification.md §8.3). There
 * is no Redis-backed cache on the API itself yet; see the Phase 7
 * report for that scope decision.
 */

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

export interface PublicAddress {
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

export interface PublicBranding {
  logoUrl: string | null;
  coverImageUrl: string | null;
  themePrimaryColor: string | null;
  themeAccentColor: string | null;
  tagline: string | null;
}

export interface PublicSettings {
  minOrderAmountMinor: string;
  packagingFeeMinor: string;
  deliveryFeeMode: string;
  deliveryFeeFlatMinor: string;
  acceptsOnlinePayment: boolean;
}

export interface PublicHoursRow {
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
}

export type AvailabilityReason = 'ACCEPTING' | 'SUSPENDED' | 'DISABLED' | 'CLOSED_NOW' | 'ON_BREAK';

export interface PublicRestaurant {
  slug: string;
  name: string;
  description: string | null;
  timezone: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  avgPrepMinutes: number | null;
  ratingAvg: number | null;
  ratingCount: number;
  availability: { accepting: boolean; reason: AvailabilityReason };
  address: PublicAddress | null;
  branding: PublicBranding | null;
  settings: PublicSettings | null;
  hours: PublicHoursRow[];
}

export interface PublicMenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  priceMinor: string;
  currency: string;
  imageUrl: string | null;
  isAvailable: boolean;
  dietaryTag: 'VEG' | 'NON_VEG' | 'EGG' | 'UNKNOWN';
  displayOrder: number;
}

export interface PublicMenuCategory {
  id: string;
  name: string;
  description: string | null;
  displayOrder: number;
  items: PublicMenuItem[];
}

export interface PublicMenu {
  categories: PublicMenuCategory[];
}

async function fetchPublic<T>(path: string): Promise<T | null> {
  const res = await fetch(`${API_BASE_URL}/api/v1${path}`, { next: { revalidate: 60 } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Public API request to ${path} failed with ${res.status}`);
  }
  const json = (await res.json()) as { data: T };
  return json.data;
}

export function fetchPublicRestaurant(slug: string): Promise<PublicRestaurant | null> {
  return fetchPublic<PublicRestaurant>(`/public/restaurants/${encodeURIComponent(slug)}`);
}

export function fetchPublicMenu(slug: string): Promise<PublicMenu | null> {
  return fetchPublic<PublicMenu>(`/public/restaurants/${encodeURIComponent(slug)}/menu`);
}
