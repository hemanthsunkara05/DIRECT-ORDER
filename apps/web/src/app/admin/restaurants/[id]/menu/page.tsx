'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { formatINR, toMinor } from '@direct-order/money';
import { AdminGuard } from '@/lib/auth/admin-guard';
import {
  ApiError,
  adminApi,
  type DietaryTag,
  type MenuCategory,
  type MenuItem,
} from '@/lib/api-client';

export default function AdminMenuPage() {
  return (
    <AdminGuard>
      <MenuEditor />
    </AdminGuard>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

function moveEntry<T extends { id: string }>(entries: T[], id: string, direction: -1 | 1): T[] {
  const index = entries.findIndex((e) => e.id === id);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= entries.length) return entries;
  const next = [...entries];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

/**
 * Admin-authorized menu editor (Phase 22) — calls the exact same
 * MenuCategoryService/MenuItemService logic the owner's own menu page
 * does, through the admin-only `/admin/restaurants/:id/menu/*` routes.
 * This is the highest-value surface in the phase: it's what makes
 * "load a menu from photos an owner texted you" possible.
 */
function MenuEditor() {
  const params = useParams<{ id: string }>();
  const restaurantId = params.id;

  const [categories, setCategories] = useState<MenuCategory[] | null>(null);
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [c, i] = await Promise.all([
        adminApi.restaurants.menu.categories.list(restaurantId),
        adminApi.restaurants.menu.items.list(restaurantId),
      ]);
      setCategories(c);
      setItems(i);
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurantId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function persistCategoryOrder(next: MenuCategory[]) {
    setCategories(next);
    try {
      await adminApi.restaurants.menu.categories.reorder(
        restaurantId,
        next.map((c, i) => ({ id: c.id, displayOrder: i })),
      );
    } catch (err) {
      setError(formatError(err));
      await load();
    }
  }

  async function persistItemOrder(next: MenuItem[]) {
    setItems(next);
    try {
      await adminApi.restaurants.menu.items.reorder(
        restaurantId,
        next.map((it, i) => ({ id: it.id, displayOrder: i })),
      );
    } catch (err) {
      setError(formatError(err));
      await load();
    }
  }

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Menu</h1>
        <Link
          href={`/admin/restaurants/${restaurantId}/edit`}
          className="text-sm text-indigo-600 underline"
        >
          ← Back to profile
        </Link>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <CreateCategoryForm restaurantId={restaurantId} onCreated={() => void load()} />

      {categories === null ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : categories.length === 0 ? (
        <p className="text-sm text-slate-500">No categories yet — add one above.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {categories.map((category, i) => (
            <div key={category.id} className="rounded-md border border-slate-200 p-4">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">{category.name}</h2>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() =>
                      void persistCategoryOrder(moveEntry(categories, category.id, -1))
                    }
                    className="disabled:opacity-30"
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    disabled={i === categories.length - 1}
                    onClick={() => void persistCategoryOrder(moveEntry(categories, category.id, 1))}
                    className="disabled:opacity-30"
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void (async () => {
                        try {
                          await adminApi.restaurants.menu.categories.archive(
                            restaurantId,
                            category.id,
                          );
                          await load();
                        } catch (err) {
                          setError(formatError(err));
                        }
                      })()
                    }
                    className="text-red-600 underline"
                  >
                    Remove
                  </button>
                </div>
              </div>

              <ItemList
                restaurantId={restaurantId}
                categoryId={category.id}
                items={(items ?? []).filter((it) => it.categoryId === category.id)}
                onReorder={(next) => {
                  const others = (items ?? []).filter((it) => it.categoryId !== category.id);
                  void persistItemOrder([...others, ...next]);
                }}
                onChanged={() => void load()}
                setError={setError}
              />

              <CreateItemForm
                restaurantId={restaurantId}
                categoryId={category.id}
                onCreated={() => void load()}
              />
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function CreateCategoryForm({
  restaurantId,
  onCreated,
}: {
  restaurantId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await adminApi.restaurants.menu.categories.create(restaurantId, { name });
      setName('');
      onCreated();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex items-end gap-3">
      <label className="flex flex-1 flex-col gap-1 text-sm font-medium text-slate-700">
        New category
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Mains"
          className="rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
      </label>
      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        Add
      </button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  );
}

function ItemList({
  restaurantId,
  categoryId,
  items,
  onReorder,
  onChanged,
  setError,
}: {
  restaurantId: string;
  categoryId: string;
  items: MenuItem[];
  onReorder: (next: MenuItem[]) => void;
  onChanged: () => void;
  setError: (msg: string | null) => void;
}) {
  void categoryId;
  if (items.length === 0) {
    return <p className="mb-3 text-xs text-slate-400">No items in this category yet.</p>;
  }

  return (
    <ul className="mb-3 flex flex-col gap-2">
      {items.map((item, i) => (
        <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <span className={item.isAvailable ? '' : 'text-slate-400 line-through'}>
              {item.name}
            </span>
            <span className="font-mono text-xs text-slate-500">
              {formatINR(BigInt(item.priceMinor))}
            </span>
            <span className="text-xs text-slate-400">{item.dietaryTag}</span>
          </span>
          <span className="flex items-center gap-2 text-xs text-slate-400">
            <button
              type="button"
              disabled={i === 0}
              onClick={() => onReorder(moveEntry(items, item.id, -1))}
              className="disabled:opacity-30"
            >
              ▲
            </button>
            <button
              type="button"
              disabled={i === items.length - 1}
              onClick={() => onReorder(moveEntry(items, item.id, 1))}
              className="disabled:opacity-30"
            >
              ▼
            </button>
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  try {
                    await adminApi.restaurants.menu.items.setAvailability(
                      restaurantId,
                      item.id,
                      !item.isAvailable,
                    );
                    onChanged();
                  } catch (err) {
                    setError(err instanceof ApiError ? err.body.message : 'Something went wrong.');
                  }
                })()
              }
              className="underline"
            >
              {item.isAvailable ? 'Mark 86ed' : 'Mark available'}
            </button>
            <button
              type="button"
              onClick={() =>
                void (async () => {
                  try {
                    await adminApi.restaurants.menu.items.archive(restaurantId, item.id);
                    onChanged();
                  } catch (err) {
                    setError(err instanceof ApiError ? err.body.message : 'Something went wrong.');
                  }
                })()
              }
              className="text-red-600 underline"
            >
              Remove
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

const DIETARY_TAGS: DietaryTag[] = ['VEG', 'NON_VEG', 'EGG', 'UNKNOWN'];

function CreateItemForm({
  restaurantId,
  categoryId,
  onCreated,
}: {
  restaurantId: string;
  categoryId: string;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [priceRupees, setPriceRupees] = useState('');
  const [dietaryTag, setDietaryTag] = useState<DietaryTag>('UNKNOWN');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const priceMinor = toMinor(priceRupees.trim() || '0').toString();
      await adminApi.restaurants.menu.items.create(restaurantId, {
        categoryId,
        name,
        priceMinor,
        dietaryTag,
      });
      setName('');
      setPriceRupees('');
      setDietaryTag('UNKNOWN');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.body.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-wrap items-end gap-2 pt-2">
      <input
        type="text"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Item name"
        className="min-w-[10rem] flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
      <input
        type="number"
        min="0"
        step="0.01"
        required
        value={priceRupees}
        onChange={(e) => setPriceRupees(e.target.value)}
        placeholder="Price (₹)"
        className="w-28 shrink-0 rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
      <select
        value={dietaryTag}
        onChange={(e) => setDietaryTag(e.target.value as DietaryTag)}
        className="w-auto shrink-0 rounded-md border border-slate-300 px-3 py-2 text-sm"
      >
        {DIETARY_TAGS.map((tag) => (
          <option key={tag} value={tag}>
            {tag}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        Add item
      </button>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </form>
  );
}
