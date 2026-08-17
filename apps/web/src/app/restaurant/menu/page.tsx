'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { formatINR, toMinor } from '@direct-order/money';
import {
  ApiError,
  menuApi,
  type DietaryTag,
  type MenuCategory,
  type MenuItem,
} from '@/lib/api-client';
import { ProtectedRoute } from '@/lib/auth/protected-route';
import { useSession } from '@/lib/auth/session-context';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';

export default function MenuPage() {
  return (
    <ProtectedRoute>
      <MenuManagement />
    </ProtectedRoute>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return 'Something went wrong.';
}

/** Renumbers `displayOrder` 0..n-1 after moving `from` to `to` — the exact list the reorder API expects. */
function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

function MenuManagement() {
  const { user, activeRestaurantId } = useSession();
  const membership = user?.restaurantMemberships.find((m) => m.restaurantId === activeRestaurantId);
  const restaurantId = activeRestaurantId ?? undefined;
  const canWrite = membership?.role === 'MANAGER' || membership?.role === 'OWNER';

  const [categories, setCategories] = useState<MenuCategory[] | null>(null);
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const load = useCallback(async () => {
    if (!restaurantId) return;
    try {
      const [cats, its] = await Promise.all([
        menuApi.categories.list(restaurantId),
        menuApi.items.list(undefined, restaurantId),
      ]);
      setCategories(cats);
      setItems(its);
    } catch (err) {
      setError(formatError(err));
    }
  }, [restaurantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const itemsByCategory = useMemo(() => {
    const map = new Map<string, MenuItem[]>();
    for (const item of items ?? []) {
      const list = map.get(item.categoryId) ?? [];
      list.push(item);
      map.set(item.categoryId, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.displayOrder - b.displayOrder);
    }
    return map;
  }, [items]);

  async function reorderCategories(next: MenuCategory[]) {
    setCategories(next);
    try {
      await menuApi.categories.reorder(
        next.map((c, index) => ({ id: c.id, displayOrder: index })),
        restaurantId,
      );
      setAnnouncement('Category order saved.');
    } catch (err) {
      setError(formatError(err));
    } finally {
      await load();
    }
  }

  async function reorderItems(categoryId: string, next: MenuItem[]) {
    try {
      await menuApi.items.reorder(
        next.map((item, index) => ({ id: item.id, displayOrder: index })),
        restaurantId,
      );
      setAnnouncement('Item order saved.');
    } catch (err) {
      setError(formatError(err));
    } finally {
      await load();
    }
    void categoryId;
  }

  if (!user || !restaurantId) {
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-sm text-ink-500">You don&apos;t manage a restaurant.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-8 p-8" style={{ background: 'var(--bg)' }}>
      <h1 className="text-xl font-bold text-ink-900">Menu</h1>
      {error && <p className="text-sm font-medium text-error">{error}</p>}
      {/* Announces reorder outcomes to screen-reader users, who won't see a drag-and-drop's visual reshuffle. */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {canWrite && <CreateCategoryForm restaurantId={restaurantId} onCreated={() => void load()} />}

      {!categories && <p className="text-sm text-ink-500">Loading…</p>}
      {categories?.length === 0 && (
        <EmptyState message="No menu categories yet. Add one above to start building your menu." />
      )}

      {categories?.map((category, index) => (
        <CategoryCard
          key={category.id}
          category={category}
          items={itemsByCategory.get(category.id) ?? []}
          restaurantId={restaurantId}
          canWrite={canWrite}
          isFirst={index === 0}
          isLast={index === categories.length - 1}
          onMoveUp={() => void reorderCategories(moveItem(categories, index, index - 1))}
          onMoveDown={() => void reorderCategories(moveItem(categories, index, index + 1))}
          onDrop={(fromId) => {
            const from = categories.findIndex((c) => c.id === fromId);
            if (from === -1 || from === index) return;
            void reorderCategories(moveItem(categories, from, index));
          }}
          onChanged={() => void load()}
          onItemsReordered={(next) => void reorderItems(category.id, next)}
        />
      ))}
    </main>
  );
}

function CategoryCard({
  category,
  items,
  restaurantId,
  canWrite,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onDrop,
  onChanged,
  onItemsReordered,
}: {
  category: MenuCategory;
  items: MenuItem[];
  restaurantId: string;
  canWrite: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDrop: (draggedCategoryId: string) => void;
  onChanged: () => void;
  onItemsReordered: (next: MenuItem[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [description, setDescription] = useState(category.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSave() {
    setBusy(true);
    setError(null);
    try {
      await menuApi.categories.update(
        category.id,
        { name, description: description || null },
        restaurantId,
      );
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive() {
    setBusy(true);
    setError(null);
    try {
      await menuApi.categories.archive(category.id, restaurantId);
      onChanged();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      className="flex flex-col gap-4 rounded-card border border-ink-200 bg-surface p-[22px] shadow-1"
      draggable={canWrite}
      onDragStart={(e) => e.dataTransfer.setData('text/category-id', category.id)}
      onDragOver={(e) => canWrite && e.preventDefault()}
      onDrop={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        const draggedId = e.dataTransfer.getData('text/category-id');
        if (draggedId) onDrop(draggedId);
      }}
    >
      <div className="flex items-start justify-between gap-3">
        {editing ? (
          <div className="flex flex-1 flex-col gap-2">
            <input value={name} onChange={(e) => setName(e.target.value)} className="input" />
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input"
              rows={2}
            />
          </div>
        ) : (
          <div>
            <h2 className="text-base font-bold text-ink-900">{category.name}</h2>
            {category.description && <p className="text-sm text-ink-500">{category.description}</p>}
          </div>
        )}

        {canWrite && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label={`Move ${category.name} up`}
              disabled={isFirst}
              onClick={onMoveUp}
              className="text-xs text-ink-500 disabled:opacity-30"
            >
              ▲
            </button>
            <button
              type="button"
              aria-label={`Move ${category.name} down`}
              disabled={isLast}
              onClick={onMoveDown}
              className="text-xs text-ink-500 disabled:opacity-30"
            >
              ▼
            </button>
            {editing ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSave()}
                className="text-xs font-semibold text-ink-700 underline"
              >
                Save
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="text-xs font-semibold text-ink-700 underline"
              >
                Edit
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleArchive()}
              className="text-xs font-semibold text-error underline"
            >
              Archive
            </button>
          </div>
        )}
      </div>

      {error && <p className="text-sm font-medium text-error">{error}</p>}

      <ItemList
        items={items}
        restaurantId={restaurantId}
        canWrite={canWrite}
        onChanged={onChanged}
        onReordered={onItemsReordered}
      />

      {canWrite && (
        <CreateItemForm
          categoryId={category.id}
          restaurantId={restaurantId}
          onCreated={onChanged}
        />
      )}
    </section>
  );
}

function ItemList({
  items,
  restaurantId,
  canWrite,
  onChanged,
  onReordered,
}: {
  items: MenuItem[];
  restaurantId: string;
  canWrite: boolean;
  onChanged: () => void;
  onReordered: (next: MenuItem[]) => void;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-ink-400">No items yet.</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {items.map((item, index) => (
        <ItemRow
          key={item.id}
          item={item}
          restaurantId={restaurantId}
          canWrite={canWrite}
          isFirst={index === 0}
          isLast={index === items.length - 1}
          onMoveUp={() => onReordered(moveItem(items, index, index - 1))}
          onMoveDown={() => onReordered(moveItem(items, index, index + 1))}
          onDrop={(draggedId) => {
            const from = items.findIndex((i) => i.id === draggedId);
            if (from === -1 || from === index) return;
            onReordered(moveItem(items, from, index));
          }}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}

function ItemRow({
  item,
  restaurantId,
  canWrite,
  isFirst,
  isLast,
  onMoveUp,
  onMoveDown,
  onDrop,
  onChanged,
}: {
  item: MenuItem;
  restaurantId: string;
  canWrite: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDrop: (draggedItemId: string) => void;
  onChanged: () => void;
}) {
  // Deliberately NOT optimistic: `available` only ever reflects the last
  // server-confirmed value, so a failed toggle can never leave the
  // checkbox showing a state the backend didn't actually accept
  // (docs/14-acceptance-criteria.md, Phase 6).
  const [available, setAvailable] = useState(item.isAvailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setAvailable(item.isAvailable), [item.isAvailable]);

  async function handleToggle(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const updated = await menuApi.items.setAvailability(item.id, next, restaurantId);
      setAvailable(updated.isAvailable);
    } catch (err) {
      setError(formatError(err));
      // available intentionally left unchanged — the toggle simply
      // snaps back to the last-known-good server value.
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive() {
    setBusy(true);
    setError(null);
    try {
      await menuApi.items.archive(item.id, restaurantId);
      onChanged();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li
      className="flex items-center justify-between gap-3 rounded-ctrl border border-dashed border-ink-200 px-3 py-2"
      draggable={canWrite}
      onDragStart={(e) => e.dataTransfer.setData('text/item-id', item.id)}
      onDragOver={(e) => canWrite && e.preventDefault()}
      onDrop={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        const draggedId = e.dataTransfer.getData('text/item-id');
        if (draggedId) onDrop(draggedId);
      }}
    >
      <div className="flex flex-col">
        <span className="text-sm font-medium text-ink-900">{item.name}</span>
        <span className="font-mono text-xs text-ink-500">
          {formatINR(BigInt(item.priceMinor))} · {item.dietaryTag}
        </span>
        {error && <span className="text-xs font-medium text-error">{error}</span>}
      </div>

      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1 text-xs text-ink-700">
          <input
            type="checkbox"
            checked={available}
            disabled={busy}
            onChange={(e) => void handleToggle(e.target.checked)}
          />
          Available
        </label>

        {canWrite && (
          <>
            <button
              type="button"
              aria-label={`Move ${item.name} up`}
              disabled={isFirst}
              onClick={onMoveUp}
              className="text-xs text-ink-500 disabled:opacity-30"
            >
              ▲
            </button>
            <button
              type="button"
              aria-label={`Move ${item.name} down`}
              disabled={isLast}
              onClick={onMoveDown}
              className="text-xs text-ink-500 disabled:opacity-30"
            >
              ▼
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleArchive()}
              className="text-xs font-semibold text-error underline"
            >
              Archive
            </button>
          </>
        )}
      </div>
    </li>
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
      await menuApi.categories.create({ name }, restaurantId);
      setName('');
      onCreated();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex gap-3">
      <input
        type="text"
        required
        placeholder="New category name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="input flex-1"
      />
      <Button type="submit" disabled={submitting} loading={submitting}>
        Add category
      </Button>
      {error && <p className="text-sm font-medium text-error">{error}</p>}
    </form>
  );
}

const DIETARY_TAGS: DietaryTag[] = ['VEG', 'NON_VEG', 'EGG', 'UNKNOWN'];

function CreateItemForm({
  categoryId,
  restaurantId,
  onCreated,
}: {
  categoryId: string;
  restaurantId: string;
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
      const priceMinor = toMinor(priceRupees.trim());
      await menuApi.items.create(
        { categoryId, name, priceMinor: priceMinor.toString(), dietaryTag },
        restaurantId,
      );
      setName('');
      setPriceRupees('');
      onCreated();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        required
        placeholder="Item name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="input flex-1"
      />
      <input
        type="text"
        required
        inputMode="decimal"
        placeholder="Price (₹)"
        value={priceRupees}
        onChange={(e) => setPriceRupees(e.target.value)}
        className="input w-28"
      />
      <select
        value={dietaryTag}
        onChange={(e) => setDietaryTag(e.target.value as DietaryTag)}
        className="input w-auto shrink-0"
      >
        {DIETARY_TAGS.map((tag) => (
          <option key={tag} value={tag}>
            {tag}
          </option>
        ))}
      </select>
      <Button type="submit" disabled={submitting} loading={submitting}>
        Add item
      </Button>
      {error && <p className="w-full text-sm font-medium text-error">{error}</p>}
    </form>
  );
}
