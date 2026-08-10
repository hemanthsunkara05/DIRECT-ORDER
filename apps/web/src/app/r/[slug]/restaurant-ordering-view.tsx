'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatINR } from '@direct-order/money';
import type { PublicMenu, PublicMenuItem, PublicRestaurant } from '@/lib/public-api';

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
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 pb-28">
      <header className="flex flex-col gap-2 border-b border-slate-200 p-6">
        <div className="flex items-center gap-3">
          {restaurant.branding?.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element -- no image-domain config exists for this MVP; a plain <img> avoids requiring one.
            <img
              src={restaurant.branding.logoUrl}
              alt=""
              loading="lazy"
              className="h-12 w-12 rounded-full object-cover"
            />
          )}
          <div>
            <h1 className="text-xl font-semibold">{restaurant.name}</h1>
            {restaurant.branding?.tagline && (
              <p className="text-sm text-slate-500">{restaurant.branding.tagline}</p>
            )}
          </div>
        </div>
        {restaurant.description && (
          <p className="text-sm text-slate-600">{restaurant.description}</p>
        )}
        <p
          className={`w-fit rounded-full px-3 py-1 text-xs font-medium ${
            canOrder ? 'bg-green-100 text-green-800' : 'bg-slate-100 text-slate-600'
          }`}
        >
          {availabilityMessage(restaurant)}
        </p>
      </header>

      <nav
        aria-label="Menu categories"
        className="sticky top-0 z-10 flex gap-2 overflow-x-auto border-b border-slate-100 bg-white/95 px-6 py-3 backdrop-blur"
      >
        {menu.categories.map((category) => (
          <a
            key={category.id}
            href={`#category-${category.id}`}
            className="whitespace-nowrap rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {category.name}
          </a>
        ))}
      </nav>

      <div className="px-6">
        <label className="flex flex-col gap-1 text-sm font-medium text-slate-700">
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
        {visibleCategories.length === 0 && (
          <p className="text-sm text-slate-500">No items match your search.</p>
        )}
        {visibleCategories.map((category) => (
          <section key={category.id} id={`category-${category.id}`} className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{category.name}</h2>
            {category.description && (
              <p className="text-sm text-slate-500">{category.description}</p>
            )}
            <ul className="flex flex-col gap-3">
              {category.items.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  canOrder={canOrder}
                  onAdd={() => addToCart(item)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {cartCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 border-t border-slate-200 bg-white shadow-lg">
          {cartOpen && (
            <ul className="max-h-64 overflow-y-auto border-b border-slate-100 px-6 py-3">
              {cart.map((c) => (
                <li key={c.itemId} className="flex items-center justify-between py-1 text-sm">
                  <span>
                    {c.quantity}× {c.name}
                  </span>
                  <div className="flex items-center gap-3">
                    <span>{formatINR(BigInt(c.priceMinor) * BigInt(c.quantity))}</span>
                    <button
                      type="button"
                      onClick={() => removeFromCart(c.itemId)}
                      className="text-xs text-red-600 underline"
                      aria-label={`Remove ${c.name} from cart`}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => setCartOpen((open) => !open)}
            aria-expanded={cartOpen}
            className="flex w-full items-center justify-between px-6 py-4"
          >
            <span className="text-sm font-medium">
              {cartCount} item{cartCount === 1 ? '' : 's'} · {formatINR(cartSubtotalMinor)}
            </span>
            <span className="text-xs text-slate-500">{cartOpen ? 'Hide cart' : 'View cart'}</span>
          </button>
        </div>
      )}
    </main>
  );
}

function ItemCard({
  item,
  canOrder,
  onAdd,
}: {
  item: PublicMenuItem;
  canOrder: boolean;
  onAdd: () => void;
}) {
  const addable = canOrder && item.isAvailable;
  return (
    <li className="flex items-center justify-between gap-4 rounded-lg border border-slate-100 p-3">
      <div className="flex items-center gap-3">
        {item.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- see header logo above.
          <img
            src={item.imageUrl}
            alt=""
            loading="lazy"
            className="h-16 w-16 rounded-md object-cover"
          />
        )}
        <div>
          <p className="text-sm font-medium">
            {item.name}
            {item.dietaryTag !== 'UNKNOWN' && (
              <span className="ml-2 text-xs text-slate-400">
                {item.dietaryTag.replace('_', ' ')}
              </span>
            )}
          </p>
          {item.description && <p className="text-xs text-slate-500">{item.description}</p>}
          <p className="text-sm text-slate-700">{formatINR(BigInt(item.priceMinor))}</p>
          {!item.isAvailable && <p className="text-xs text-red-600">Sold out</p>}
        </div>
      </div>
      <button type="button" disabled={!addable} onClick={onAdd} className="btn-primary shrink-0">
        Add
      </button>
    </li>
  );
}
