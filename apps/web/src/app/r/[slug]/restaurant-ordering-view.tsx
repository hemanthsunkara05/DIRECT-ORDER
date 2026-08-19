'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { formatINR } from '@direct-order/money';
import {
  ApiError,
  checkoutApi,
  reviewsApi,
  type CartIssue,
  type PublicReview,
  type QuoteResult,
} from '@/lib/api-client';
import type { PublicMenu, PublicMenuItem, PublicRestaurant } from '@/lib/public-api';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusPill, type StatusTone } from '@/components/ui/StatusPill';

interface CartItem {
  itemId: string;
  name: string;
  priceMinor: string;
  quantity: number;
}

/**
 * Keyed by restaurant slug so each restaurant's cart lives in its own
 * localStorage slot — switching restaurants can never mix their items
 * into one cart (docs/14-acceptance-criteria.md, Phase 7: "cart rejects
 * cross-restaurant items"), by construction rather than a runtime check.
 */
function cartStorageKey(slug: string): string {
  return `do_cart:${slug}`;
}

function loadCart(slug: string): CartItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(cartStorageKey(slug));
    return raw ? (JSON.parse(raw) as CartItem[]) : [];
  } catch {
    return [];
  }
}

function saveCart(slug: string, items: CartItem[]): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(cartStorageKey(slug), JSON.stringify(items));
}

function availabilityMessage(restaurant: PublicRestaurant): string {
  if (restaurant.status === 'SUSPENDED') return 'This restaurant is temporarily unavailable.';
  if (restaurant.status === 'CLOSED') return 'This restaurant is no longer available.';
  switch (restaurant.availability.reason) {
    case 'ACCEPTING':
      return 'Accepting orders now';
    case 'ON_BREAK':
      return 'Temporarily on a break';
    case 'DISABLED':
      return 'Not accepting orders right now';
    case 'CLOSED_NOW':
    default:
      return 'Currently closed';
  }
}

function availabilityTone(restaurant: PublicRestaurant): StatusTone {
  if (restaurant.status === 'SUSPENDED') return 'error';
  if (restaurant.status === 'CLOSED') return 'error';
  return restaurant.availability.accepting ? 'fresh' : 'warn';
}

function issueMessage(issue: CartIssue, cart: CartItem[]): string {
  const itemName = (itemId: string) => cart.find((c) => c.itemId === itemId)?.name ?? 'This item';
  switch (issue.code) {
    case 'RESTAURANT_UNAVAILABLE':
      return "This restaurant isn't accepting orders right now.";
    case 'ITEM_UNAVAILABLE':
      return `${itemName(issue.itemId)} is no longer available and has been excluded from your total.`;
    case 'PRICE_CHANGED':
      return `${itemName(issue.itemId)}'s price changed to ${formatINR(BigInt(issue.newPriceMinor))}. Remove and re-add it to accept the new price.`;
    case 'BELOW_MINIMUM_ORDER':
      return `Minimum order is ${formatINR(BigInt(issue.minimumMinor))} — add ${formatINR(BigInt(issue.minimumMinor) - BigInt(issue.subtotalMinor))} more.`;
    default:
      return 'There is a problem with your cart.';
  }
}

export function RestaurantOrderingView({
  restaurant,
  menu,
}: {
  restaurant: PublicRestaurant;
  menu: PublicMenu;
}) {
  const [cart, setCart] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [cartOpen, setCartOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const router = useRouter();

  // Cart hydration is client-only (localStorage doesn't exist during
  // SSR) — loaded once per slug on mount, then every change is
  // persisted back, giving "persists across refresh" for free.
  useEffect(() => {
    setCart(loadCart(restaurant.slug));
    setHydrated(true);
  }, [restaurant.slug]);

  useEffect(() => {
    if (hydrated) saveCart(restaurant.slug, cart);
  }, [cart, hydrated, restaurant.slug]);

  // Re-quotes on every cart change — this IS the server-side cart
  // validation (docs/13-implementation-phases.md, Phase 8), not a
  // client-side estimate: prices, fees, and issue detection all come
  // from POST /public/checkout/quote, never computed locally.
  useEffect(() => {
    if (!hydrated) return;
    if (cart.length === 0) {
      setQuote(null);
      setQuoteError(null);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    setQuoteError(null);
    checkoutApi
      .quote({
        restaurantSlug: restaurant.slug,
        items: cart.map((c) => ({
          itemId: c.itemId,
          quantity: c.quantity,
          unitPriceMinorAtAdd: c.priceMinor,
        })),
      })
      .then((result) => {
        if (!cancelled) setQuote(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setQuoteError(err instanceof ApiError ? err.body.message : 'Could not price your cart.');
        }
      })
      .finally(() => {
        if (!cancelled) setQuoting(false);
      });
    return () => {
      cancelled = true;
    };
  }, [cart, hydrated, restaurant.slug]);

  function addToCart(item: PublicMenuItem) {
    setCart((prev) => {
      const existing = prev.find((c) => c.itemId === item.id);
      if (existing) {
        return prev.map((c) => (c.itemId === item.id ? { ...c, quantity: c.quantity + 1 } : c));
      }
      return [
        ...prev,
        { itemId: item.id, name: item.name, priceMinor: item.priceMinor, quantity: 1 },
      ];
    });
  }

  function removeFromCart(itemId: string) {
    setCart((prev) => prev.filter((c) => c.itemId !== itemId));
  }

  function decrementInCart(itemId: string) {
    setCart((prev) => {
      const existing = prev.find((c) => c.itemId === itemId);
      if (!existing) return prev;
      if (existing.quantity <= 1) return prev.filter((c) => c.itemId !== itemId);
      return prev.map((c) => (c.itemId === itemId ? { ...c, quantity: c.quantity - 1 } : c));
    });
  }

  const cartCount = cart.reduce((sum, c) => sum + c.quantity, 0);
  const cartSubtotalMinor = cart.reduce(
    (sum, c) => sum + BigInt(c.priceMinor) * BigInt(c.quantity),
    0n,
  );

  const normalizedSearch = search.trim().toLowerCase();
  const visibleCategories = useMemo(() => {
    if (!normalizedSearch) return menu.categories;
    return menu.categories
      .map((category) => ({
        ...category,
        items: category.items.filter(
          (item) =>
            item.name.toLowerCase().includes(normalizedSearch) ||
            (item.description ?? '').toLowerCase().includes(normalizedSearch),
        ),
      }))
      .filter((category) => category.items.length > 0);
  }, [menu.categories, normalizedSearch]);

  const canOrder = restaurant.availability.accepting;

  return (
    <main
      className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 pb-28"
      style={{ background: 'var(--bg)' }}
    >
      <header className="flex flex-col gap-2 border-b border-ink-200 p-6">
        <div className="flex items-center gap-3">
          {restaurant.branding?.logoUrl && (
            <Image
              src={restaurant.branding.logoUrl}
              alt=""
              width={48}
              height={48}
              className="h-12 w-12 rounded-full object-cover"
            />
          )}
          <div>
            <h1 className="text-xl font-bold text-ink-900">{restaurant.name}</h1>
            {restaurant.branding?.tagline && (
              <p className="text-sm text-ink-500">{restaurant.branding.tagline}</p>
            )}
            <p className="font-mono text-xs text-ink-500">
              {restaurant.ratingAvg !== null
                ? // Not money — a 1-5 star rating average, not a currency amount.
                  // eslint-disable-next-line no-restricted-syntax
                  `★ ${restaurant.ratingAvg.toFixed(1)} (${restaurant.ratingCount} review${restaurant.ratingCount === 1 ? '' : 's'})`
                : 'No ratings yet'}
            </p>
          </div>
        </div>
        {restaurant.description && <p className="text-sm text-ink-700">{restaurant.description}</p>}
        <div>
          <StatusPill label={availabilityMessage(restaurant)} tone={availabilityTone(restaurant)} />
        </div>
      </header>

      <nav
        aria-label="Menu categories"
        className="sticky top-0 z-10 flex gap-2 overflow-x-auto border-b border-ink-200 px-6 py-3 backdrop-blur"
        style={{ background: 'rgba(251,250,247,.95)' }}
      >
        {menu.categories.map((category) => (
          <a
            key={category.id}
            href={`#category-${category.id}`}
            className="whitespace-nowrap rounded-pill border border-ink-200 px-3 py-1 text-xs font-medium text-ink-700 hover:border-brand-600 hover:bg-brand-100"
          >
            {category.name}
          </a>
        ))}
      </nav>

      <div className="px-6">
        <label className="flex flex-col gap-1 text-sm font-medium text-ink-700">
          <span className="sr-only">Search this menu</span>
          <input
            type="search"
            placeholder="Search the menu…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input"
          />
        </label>
      </div>

      <div className="flex flex-col gap-8 px-6">
        {visibleCategories.length === 0 &&
          (normalizedSearch ? (
            <EmptyState message={`No items match "${search.trim()}".`} />
          ) : (
            <EmptyState message="This restaurant hasn't added any menu items yet." />
          ))}
        {visibleCategories.map((category) => (
          <section key={category.id} id={`category-${category.id}`} className="flex flex-col gap-3">
            <h2 className="text-lg font-bold text-ink-900">{category.name}</h2>
            {category.description && <p className="text-sm text-ink-500">{category.description}</p>}
            <ul className="flex flex-col gap-3">
              {category.items.map((item) => {
                const quantity = cart.find((c) => c.itemId === item.id)?.quantity ?? 0;
                return (
                  <ItemCard
                    key={item.id}
                    item={item}
                    canOrder={canOrder}
                    quantity={quantity}
                    onIncrement={() => addToCart(item)}
                    onDecrement={() => decrementInCart(item.id)}
                  />
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <div className="px-6">
        <Reviews slug={restaurant.slug} />
      </div>

      {cartCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-20 border-t border-ink-200 bg-surface shadow-3">
          {cartOpen && (
            <div className="max-h-80 overflow-y-auto border-b border-ink-200 px-6 py-3">
              <ul>
                {cart.map((c) => (
                  <li
                    key={c.itemId}
                    className="flex items-center justify-between border-t border-dashed border-ink-200 py-2 text-sm first:border-t-0"
                  >
                    <span className="text-ink-800">
                      {c.quantity}× {c.name}
                    </span>
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-ink-800">
                        {formatINR(BigInt(c.priceMinor) * BigInt(c.quantity))}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeFromCart(c.itemId)}
                        className="text-xs font-semibold text-error underline"
                        aria-label={`Remove ${c.name} from cart`}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex flex-col gap-1 border-t border-ink-200 pt-3 text-sm">
                {quoting && <p className="text-xs text-ink-400">Pricing your order…</p>}
                {quoteError && <p className="text-xs text-error">{quoteError}</p>}
                {quote?.issues.map((issue, index) => (
                  <p key={index} className="text-xs text-warn-700">
                    {issueMessage(issue, cart)}
                  </p>
                ))}
                {quote && (
                  <>
                    <Row label="Subtotal" valueMinor={quote.breakdown.itemsSubtotalMinor} />
                    {quote.breakdown.packagingFeeMinor !== '0' && (
                      <Row label="Packaging" valueMinor={quote.breakdown.packagingFeeMinor} />
                    )}
                    {quote.breakdown.deliveryFeeMinor !== '0' && (
                      <Row label="Delivery" valueMinor={quote.breakdown.deliveryFeeMinor} />
                    )}
                    {quote.breakdown.platformFeeMinor !== '0' && (
                      <Row label="Platform fee" valueMinor={quote.breakdown.platformFeeMinor} />
                    )}
                    {quote.breakdown.taxMinor !== '0' && (
                      <Row label="Tax" valueMinor={quote.breakdown.taxMinor} />
                    )}
                    {quote.breakdown.discountMinor !== '0' && (
                      <Row label="Discount" valueMinor={`-${quote.breakdown.discountMinor}`} />
                    )}
                    <div className="flex items-center justify-between pt-1 font-semibold text-ink-900">
                      <span>Total</span>
                      <span className="font-mono">
                        {formatINR(BigInt(quote.breakdown.payableTotalMinor))}
                      </span>
                    </div>
                  </>
                )}
                <Button
                  disabled={!quote?.valid}
                  onClick={() => router.push(`/r/${restaurant.slug}/checkout`)}
                  className="mt-2 w-full"
                >
                  {canOrder ? 'Proceed to checkout' : 'Restaurant unavailable'}
                </Button>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => setCartOpen((open) => !open)}
            aria-expanded={cartOpen}
            className="flex w-full items-center justify-between px-6 py-4"
          >
            <span className="font-mono text-sm font-semibold text-ink-900">
              {cartCount} item{cartCount === 1 ? '' : 's'} · {formatINR(cartSubtotalMinor)}
            </span>
            <span className="text-xs font-semibold text-brand-600">
              {cartOpen ? 'Hide cart' : 'View cart'}
            </span>
          </button>
        </div>
      )}
    </main>
  );
}

/** `GET /public/restaurants/:slug/reviews` (Phase 15) — display only, `authorFirstName` is already the full BR-124 allowlist the API applies. */
function Reviews({ slug }: { slug: string }) {
  const [reviews, setReviews] = useState<PublicReview[] | null>(null);

  useEffect(() => {
    reviewsApi
      .listPublic(slug)
      .then(setReviews)
      .catch(() => setReviews([]));
  }, [slug]);

  if (!reviews || reviews.length === 0) return null;

  return (
    <section className="flex flex-col gap-3 border-t border-ink-200 pt-6">
      <h2 className="text-lg font-bold text-ink-900">Reviews</h2>
      <ul className="flex flex-col gap-3">
        {reviews.map((review) => (
          <li
            key={review.id}
            className="rounded-card border border-ink-200 bg-surface p-3 text-sm shadow-1"
          >
            <div className="flex items-center justify-between">
              <span className="font-medium text-brand-600">{'★'.repeat(review.rating)}</span>
              <span className="text-xs text-ink-400">{review.authorFirstName}</span>
            </div>
            {review.body && <p className="mt-1 text-ink-700">{review.body}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ label, valueMinor }: { label: string; valueMinor: string }) {
  return (
    <div className="flex items-center justify-between text-xs text-ink-500">
      <span>{label}</span>
      <span className="font-mono">{formatINR(BigInt(valueMinor))}</span>
    </div>
  );
}

function ItemCard({
  item,
  canOrder,
  quantity,
  onIncrement,
  onDecrement,
}: {
  item: PublicMenuItem;
  canOrder: boolean;
  quantity: number;
  onIncrement: () => void;
  onDecrement: () => void;
}) {
  const addable = canOrder && item.isAvailable;
  // FSSAI marks only define two colors (veg/non-veg); EGG follows the
  // common Indian labeling convention of using the non-veg mark, since
  // the design system's token set has no third color for it.
  const dietaryColor =
    item.dietaryTag === 'VEG'
      ? 'var(--veg)'
      : item.dietaryTag === 'UNKNOWN'
        ? null
        : 'var(--nonveg)';
  return (
    <li className="flex items-center justify-between gap-4 rounded-card border border-ink-200 bg-surface p-3 shadow-1">
      <div className="flex items-center gap-3">
        {item.imageUrl && (
          <Image
            src={item.imageUrl}
            alt=""
            width={64}
            height={64}
            className="h-16 w-16 rounded-ctrl object-cover"
          />
        )}
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium text-ink-900">
            {dietaryColor && (
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-sm border"
                style={{ borderColor: dietaryColor }}
              >
                <span
                  className="block h-full w-full scale-50 rounded-full"
                  style={{ background: dietaryColor }}
                />
              </span>
            )}
            {item.name}
          </p>
          {item.description && <p className="text-xs text-ink-500">{item.description}</p>}
          <p className="font-mono text-sm text-ink-700">{formatINR(BigInt(item.priceMinor))}</p>
          {!item.isAvailable && <p className="text-xs font-semibold text-error">Sold out</p>}
        </div>
      </div>
      {quantity > 0 ? (
        <div className="flex shrink-0 items-center gap-1 rounded-pill border border-ink-200 p-1">
          <button
            type="button"
            onClick={onDecrement}
            aria-label={`Remove one ${item.name}`}
            className="flex h-7 w-7 items-center justify-center rounded-full text-base font-semibold text-ink-700 hover:bg-ink-100"
          >
            −
          </button>
          <span className="w-4 text-center font-mono text-sm font-semibold text-ink-900">
            {quantity}
          </span>
          <button
            type="button"
            disabled={!addable}
            onClick={onIncrement}
            aria-label={`Add one more ${item.name}`}
            className="flex h-7 w-7 items-center justify-center rounded-full text-base font-semibold text-ink-700 hover:bg-ink-100 disabled:opacity-40"
          >
            +
          </button>
        </div>
      ) : (
        <Button disabled={!addable} onClick={onIncrement} className="shrink-0">
          Add
        </Button>
      )}
    </li>
  );
}
