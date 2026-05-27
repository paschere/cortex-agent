import * as React from 'react';
import { clsx } from 'clsx';

export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'outline' | 'ghost';
  }
>(({ className, variant = 'default', ...props }, ref) => (
  <button
    ref={ref}
    className={clsx(
      'inline-flex items-center justify-center rounded-lg text-sm font-medium px-3 py-1.5 transition disabled:opacity-50',
      variant === 'default' &&
        'bg-neutral-900 text-white hover:opacity-90 dark:bg-white dark:text-neutral-900',
      variant === 'outline' &&
        'border hover:bg-neutral-100 dark:hover:bg-neutral-800',
      variant === 'ghost' && 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
      className,
    )}
    {...props}
  />
));
Button.displayName = 'Button';
