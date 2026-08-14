import { clsx } from 'clsx';
import * as React from 'react';

/**
 * Pill-shaped, and lifted when it is the main action on the screen.
 *
 * The primary button is the one place the brand gets to be loud, so it carries
 * both the fill and the elevation; everything else recedes to a soft outline or
 * to nothing at all. The lift grows a hair on hover — the control should feel
 * like it comes to meet the cursor.
 */
export const Button = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'default' | 'outline' | 'ghost' | 'danger';
  }
>(({ className, variant = 'default', ...props }, ref) => (
  <button
    ref={ref}
    className={clsx(
      'inline-flex items-center justify-center gap-1.5 rounded-pill px-4 py-2 text-sm font-semibold',
      'transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none',
      variant === 'default' &&
        'bg-primary text-white shadow-pop hover:-translate-y-px hover:bg-primary-strong',
      variant === 'outline' &&
        'border border-border bg-surface text-ink shadow-card hover:border-border-strong hover:bg-surface-2',
      variant === 'ghost' && 'text-ink-muted hover:bg-surface-2 hover:text-ink',
      // Reserved for what cannot be undone. It never appears on anything a
      // person can dismiss, which is what keeps the colour meaningful.
      variant === 'danger' && 'bg-rose text-white shadow-card hover:brightness-95',
      className,
    )}
    {...props}
  />
));
Button.displayName = 'Button';
