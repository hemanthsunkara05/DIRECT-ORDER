'use client';

import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * A `<input type="password">` with a show/hide toggle (the eye icon) —
 * shared across every password field in the app (admin login, restaurant
 * login, signup, reset password) rather than each page re-implementing
 * its own `showPassword` state.
 */
export function PasswordInput({
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        className={`${className ?? ''} pr-9`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        tabIndex={-1}
        className="absolute inset-y-0 right-0 flex items-center px-2.5 text-ink-400 hover:text-ink-700"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}
