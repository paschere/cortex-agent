import { clsx } from 'clsx';
import * as React from 'react';

/**
 * Pill-shaped, bold, and big enough to hit with a thumb.
 *
 * The primary button is the one place the brand gets to be loud, so it carries
 * the indigo fill; everything else recedes to a soft outline or to nothing at
 * all. Flat on purpose in the self-service design: colour, not a shadow, is
 * what says «this is the next step».
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
      'inline-flex min-h-10 items-center justify-center gap-2 rounded-pill px-5 py-2 text-sm font-bold',
      'transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none motion-reduce:transition-none',
      variant === 'default' &&
        'cortex-primary-button bg-primary text-white hover:bg-primary-strong',
      variant === 'outline' &&
        'border border-border-strong bg-surface text-ink hover:border-ink-faint/40 hover:bg-surface-2',
      variant === 'ghost' && 'text-ink-muted hover:bg-surface-2 hover:text-ink',
      // Reserved for what cannot be undone. It never appears on anything a
      // person can dismiss, which is what keeps the colour meaningful.
      variant === 'danger' && 'bg-rose text-white hover:brightness-95',
      className,
    )}
    {...props}
  />
));
Button.displayName = 'Button';
