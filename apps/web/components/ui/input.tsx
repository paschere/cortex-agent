import { clsx } from 'clsx';
import * as React from 'react';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={clsx(
      'w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-sm text-ink',
      'placeholder:text-ink-faint transition-colors',
      'focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10',
      'disabled:cursor-not-allowed disabled:opacity-60',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
