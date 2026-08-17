'use client';

import { forwardRef } from 'react';
import { Loader2 } from 'lucide-react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700',
  secondary: 'bg-surface text-ink-800 border border-ink-300 hover:bg-brand-100 hover:border-brand-600',
  ghost: 'bg-transparent text-ink-700 hover:bg-brand-100',
  destructive: 'bg-error text-white hover:bg-error-700',
};

/**
 * Counter's one button primitive (readme.md: hover darkens one ramp
 * step / tints brand-100, press is `scale(.97)` at 60ms with no color
 * change, focus is a 1.5px brand border + 3px brand-100 ring — never
 * removed). `loading` swaps the label for a spinner rather than
 * appending one, so the button's width doesn't jump mid-click.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', loading = false, disabled, className = '', children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-ctrl px-[18px] py-[11px] font-body text-sm font-semibold transition-[background-color,border-color,transform] duration-200 ease-[cubic-bezier(.2,.7,.3,1)] active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-brand-100 focus-visible:border-brand-600 motion-reduce:transition-none motion-reduce:active:scale-100 ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      {loading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span className="sr-only">Loading</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});
