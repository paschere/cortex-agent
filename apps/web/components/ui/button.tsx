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
      'inline-flex items-center justify-center gap-1.5 rounded-pill px-4 py-2 text-[13px] font-semibold transition-colors',
      'focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-primary/15 disabled:opacity-50',
      variant === 'default' && 'bg-primary text-white shadow-pop hover:bg-primary-strong',
      variant === 'outline' && 'border border-border bg-surface text-ink hover:bg-surface-2 hover:border-border-strong',
      variant === 'ghost' && 'text-ink-muted hover:bg-surface-2 hover:text-ink',
      className,
    )}
    {...props}
  />
));
Button.displayName = 'Button';
