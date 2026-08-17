import type { Config } from 'tailwindcss';

/**
 * Maps Counter's CSS custom properties (apps/web/src/app/globals.css,
 * copied from the reference design package) onto Tailwind's color/
 * radius/spacing scales, so pages use `bg-ink-900`/`text-brand-600`/
 * `bg-fresh-100`/etc. instead of hardcoded hex or Tailwind's own
 * default slate/amber/red palettes. Referencing `var(--token)` (not
 * inlining the hex here) keeps `--brand-*`'s documented purpose —
 * swappable per-restaurant at runtime — actually swappable: changing
 * the CSS variable at runtime repaints every `brand-*` class with it,
 * which a hardcoded Tailwind hex could never do.
 */
export default {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          100: 'var(--ink-100)',
          200: 'var(--ink-200)',
          300: 'var(--ink-300)',
          400: 'var(--ink-400)',
          500: 'var(--ink-500)',
          600: 'var(--ink-600)',
          700: 'var(--ink-700)',
          800: 'var(--ink-800)',
          900: 'var(--ink-900)',
        },
        brand: {
          100: 'var(--brand-100)',
          200: 'var(--brand-200)',
          300: 'var(--brand-300)',
          400: 'var(--brand-400)',
          500: 'var(--brand-500)',
          600: 'var(--brand-600)',
          700: 'var(--brand-700)',
          800: 'var(--brand-800)',
          900: 'var(--brand-900)',
        },
        fresh: {
          100: 'var(--fresh-100)',
          500: 'var(--fresh-500)',
          700: 'var(--fresh-700)',
        },
        warn: {
          DEFAULT: 'var(--warn)',
          100: 'var(--warn-100)',
          700: 'var(--warn-700)',
        },
        error: {
          DEFAULT: 'var(--error)',
          100: 'var(--error-100)',
          700: 'var(--error-700)',
        },
        veg: 'var(--veg)',
        nonveg: 'var(--nonveg)',
        bg: 'var(--bg)',
        surface: 'var(--surface)',
      },
      borderColor: {
        DEFAULT: 'var(--border)',
      },
      borderRadius: {
        card: 'var(--r-card)',
        ctrl: 'var(--r-ctrl)',
        sm: 'var(--r-sm)',
        pill: 'var(--r-pill)',
      },
      boxShadow: {
        1: 'var(--sh-1)',
        2: 'var(--sh-2)',
        3: 'var(--sh-3)',
      },
      fontFamily: {
        display: 'var(--font-display)',
        body: 'var(--font-body)',
        mono: 'var(--font-mono)',
      },
    },
  },
  plugins: [],
} satisfies Config;
