import { clsx } from 'clsx';
import * as React from 'react';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={clsx(
      'w-full rounded-sm border border-border-strong bg-surface px-3.5 py-2.5 text-sm text-ink',
      'placeholder:text-ink-faint transition-colors',
      'focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/15',
      'disabled:cursor-not-allowed disabled:opacity-60',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
