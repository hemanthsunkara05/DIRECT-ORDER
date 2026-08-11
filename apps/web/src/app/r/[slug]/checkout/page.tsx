'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatINR } from '@direct-order/money';
import { ApiError, cartApi, checkoutApi, orderApi } from '@/lib/api-client';
import { fetchPublicRestaurant, type PublicRestaurant } from '@/lib/public-api';

interface CartItem {
  itemId: string;
  name: string;
  priceMinor: string;
  quantity: number;
}

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

/**
 * `POST /public/carts` → `POST /public/checkout` (docs/04-api-
 * specification.md §8.3). The local (browser) cart built up on the
 * restaurant page is only ever persisted server-side right here, at
 * the point a customer actually commits to ordering — there is no
 * scenario yet where a customer needs to keep editing a server-
 * persisted cart across visits (same reasoning as CartRepository's own
 * doc comment).
 */
export default function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const router = useRouter();
  const [slug, setSlug] = useState<string | null>(null);
  const [restaurant, setRestaurant] = useState<PublicRestaurant | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [postalCode, setPostalCode] = useState('');

  const [couponCode, setCouponCode] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<string | null>(null);
  const [couponDiscountMinor, setCouponDiscountMinor] = useState<string | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [checkingCoupon, setCheckingCoupon] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stable for the lifetime of this page instance — a double-click on
  // "Place order" reuses the same key rather than minting a second one
  // (docs/04 §8.2's Idempotency-Key contract is what actually prevents
  // a duplicate order either way; this just makes the common case clean).
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    void params.then(({ slug: s }) => {
      setSlug(s);
      const loaded = loadCart(s);
      setCart(loaded);
      setHydrated(true);
      fetchPublicRestaurant(s)
        .then(setRestaurant)
        .catch(() => setRestaurant(null));
    });
  }, [params]);

  useEffect(() => {
    if (hydrated && cart.length === 0 && slug) {
      router.replace(`/r/${slug}`);
    }
  }, [hydrated, cart.length, slug, router]);

  const subtotalMinor = cart.reduce(
    (sum, c) => sum + BigInt(c.priceMinor) * BigInt(c.quantity),
    0n,
  );

  /**
   * A preview only (`POST /public/checkout/quote`, non-locking — see
   * that endpoint's own doc comment) — the coupon is re-validated and
   * actually reserved server-side at real checkout regardless of what
   * this preview said, so a coupon that looked valid here can still be
   * rejected on submit (e.g. someone else claimed the last use in the
   * meantime); `checkoutErrorMessage` below handles that case too.
   */
  async function handleApplyCoupon() {
    if (!slug || !couponCode.trim()) return;
    setCheckingCoupon(true);
    setCouponError(null);
    try {
      const result = await checkoutApi.quote({
        restaurantSlug: slug,
        items: cart.map((c) => ({
          itemId: c.itemId,
          quantity: c.quantity,
          unitPriceMinorAtAdd: c.priceMinor,
        })),
        couponCode: couponCode.trim(),
      });
      const couponIssue = result.issues.find(
        (issue) => issue.code === 'COUPON_INVALID' || issue.code === 'COUPON_EXHAUSTED',
      );
      if (couponIssue?.code === 'COUPON_EXHAUSTED') {
        setCouponError('This coupon has reached its usage limit.');
        setAppliedCoupon(null);
        setCouponDiscountMinor(null);
      } else if (couponIssue) {
        setCouponError('This coupon code is not valid for this order.');
        setAppliedCoupon(null);
        setCouponDiscountMinor(null);
      } else {
        setAppliedCoupon(couponCode.trim());
        setCouponDiscountMinor(result.breakdown.promotionDiscountMinor);
      }
    } catch {
      setCouponError('Could not check this coupon. Please try again.');
    } finally {
      setCheckingCoupon(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!slug || submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      const { cartId, guestToken } = await cartApi.create({
        restaurantSlug: slug,
        items: cart.map((c) => ({
          itemId: c.itemId,
          quantity: c.quantity,
          unitPriceMinorAtAdd: c.priceMinor,
        })),
      });

      const result = await orderApi.checkout(
        {
          cartId,
          guestToken,
          customer: { name, phone, email: email || undefined },
          deliveryAddress: { line1, city, postalCode },
          couponCode: appliedCoupon ?? undefined,
        },
        idempotencyKey,
      );

      // The cart converted server-side — clear the local copy so a
      // browser-back doesn't resubmit a now-stale cart.
      window.localStorage.removeItem(cartStorageKey(slug));

      const token = result.accessToken;
      if (token) {
        router.push(`/orders/${result.orderNumber}?token=${encodeURIComponent(token)}`);
      } else {
        // Idempotent replay with no reissued token (see CheckoutService's
        // doc comment) — vanishingly rare on a first submit, but handled
        // rather than left as a dead end.
        setError(
          `Your order ${result.orderNumber} was already placed. Check your confirmation from the original attempt.`,
        );
      }
    } catch (err) {
      if (err instanceof ApiError) {
        setError(checkoutErrorMessage(err));
      } else {
        setError('Something went wrong placing your order. Please try again.');
      }
      setSubmitting(false);
    }
  }

  if (!hydrated || !slug) {
    return <main className="mx-auto max-w-xl p-6 text-sm text-slate-500">Loading…</main>;
  }

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <div>
        <button
          type="button"
          onClick={() => router.push(`/r/${slug}`)}
          className="text-sm text-slate-500 underline"
        >
          ← Back to menu
        </button>
        <h1 className="mt-2 text-xl font-semibold">
          Checkout{restaurant ? ` — ${restaurant.name}` : ''}
        </h1>
      </div>

      <section className="rounded-lg border border-slate-200 p-4">
        <h2 className="mb-2 text-sm font-semibold">Your order</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {cart.map((c) => (
            <li key={c.itemId} className="flex items-center justify-between">
              <span>
                {c.quantity}× {c.name}
              </span>
              <span>{formatINR(BigInt(c.priceMinor) * BigInt(c.quantity))}</span>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2 text-sm font-semibold">
          <span>Subtotal</span>
          <span>{formatINR(subtotalMinor)}</span>
        </div>
        {appliedCoupon && couponDiscountMinor && (
          <div className="mt-1 flex items-center justify-between text-sm text-emerald-700">
            <span>Coupon {appliedCoupon}</span>
            <span>−{formatINR(BigInt(couponDiscountMinor))}</span>
          </div>
        )}
        <p className="mt-1 text-xs text-slate-400">
          Fees, tax, and the final total are computed server-side at checkout.
        </p>

        <div className="mt-3 flex gap-2 border-t border-slate-100 pt-3">
          <input
            type="text"
            value={couponCode}
            onChange={(e) => {
              setCouponCode(e.target.value.toUpperCase());
              setAppliedCoupon(null);
              setCouponDiscountMinor(null);
              setCouponError(null);
            }}
            placeholder="Coupon code"
            className="input flex-1"
          />
          <button
            type="button"
            disabled={checkingCoupon || !couponCode.trim()}
            onClick={() => void handleApplyCoupon()}
            className="btn-secondary disabled:cursor-not-allowed"
          >
            {checkingCoupon ? 'Checking…' : appliedCoupon ? 'Applied' : 'Apply'}
          </button>
        </div>
        {couponError && <p className="mt-1 text-xs text-red-600">{couponError}</p>}
      </section>

      <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Contact details</legend>
          <label className="flex flex-col gap-1 text-sm">
            Full name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Phone
            <input
              required
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91XXXXXXXXXX"
              className="input"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Email (optional)
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
            />
          </label>
        </fieldset>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Delivery address</legend>
          <label className="flex flex-col gap-1 text-sm">
            Address
            <input
              required
              value={line1}
              onChange={(e) => setLine1(e.target.value)}
              className="input"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            City
            <input
              required
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="input"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Postal code
            <input
              required
              value={postalCode}
              onChange={(e) => setPostalCode(e.target.value)}
              className="input"
            />
          </label>
        </fieldset>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="btn-primary disabled:cursor-not-allowed"
        >
          {submitting ? 'Placing order…' : `Place order — ${formatINR(subtotalMinor)}`}
        </button>
      </form>
    </main>
  );
}

function checkoutErrorMessage(err: ApiError): string {
  switch (err.body.code) {
    case 'RESTAURANT_UNAVAILABLE':
      return "This restaurant isn't accepting orders right now.";
    case 'ITEM_UNAVAILABLE':
      return 'One or more items in your cart are no longer available. Please go back and update your cart.';
    case 'PRICE_CHANGED':
      return 'One or more prices changed since you added them. Please go back and review your cart.';
    case 'MIN_ORDER_NOT_MET':
      return "Your order is below this restaurant's minimum order amount.";
    case 'COUPON_INVALID':
      return 'This coupon code is not valid for this order. Please remove it and try again.';
    case 'COUPON_EXHAUSTED':
      return 'This coupon has reached its usage limit since you applied it. Please remove it and try again.';
    case 'CART_NOT_FOUND':
    case 'CART_EMPTY':
      return 'Your cart could not be found. Please go back and try again.';
    default:
      return err.body.message || 'Something went wrong placing your order.';
  }
}
