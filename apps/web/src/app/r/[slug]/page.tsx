import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { fetchPublicMenu, fetchPublicRestaurant } from '@/lib/public-api';
import { RestaurantOrderingView } from './restaurant-ordering-view';

interface PageParams {
  params: Promise<{ slug: string }>;
}

/**
 * SSR restaurant page with dynamic metadata and Open Graph tags
 * (docs/13-implementation-phases.md, Phase 7) — a real Server Component,
 * not a client-side fetch behind a spinner, so a shared link unfurls
 * correctly and the page is indexable.
 */
export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const restaurant = await fetchPublicRestaurant(slug);
  if (!restaurant) {
    return { title: 'Restaurant not found — Direct-Order' };
  }

  const description =
    restaurant.description ??
    restaurant.branding?.tagline ??
    `Order directly from ${restaurant.name}.`;

  return {
    title: `${restaurant.name} — Direct-Order`,
    description,
    openGraph: {
      title: restaurant.name,
      description,
      images: restaurant.branding?.coverImageUrl ? [restaurant.branding.coverImageUrl] : undefined,
    },
  };
}

export default async function RestaurantPage({ params }: PageParams) {
  const { slug } = await params;
  const [restaurant, menu] = await Promise.all([
    fetchPublicRestaurant(slug),
    fetchPublicMenu(slug),
  ]);

  // Both endpoints 404 identically for a nonexistent/unpublished slug
  // (PublicRestaurantService); either being null is the same case.
  if (!restaurant || !menu) {
    notFound();
  }

  return <RestaurantOrderingView restaurant={restaurant} menu={menu} />;
}
