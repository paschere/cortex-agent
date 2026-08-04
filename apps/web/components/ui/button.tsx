import { clsx } from 'clsx';
import * as React from 'react';

/**
 * Squared, not pill-shaped, and unshadowed.
 *
 * A pill with a soft drop shadow is the consumer-app default; on a document it
 * reads as a sticker laid on top of the form. These are the boxes you tick and
 * the stamps you apply: rectangular, ruled, and flat against the page. Weight
 * and colour carry the hierarchy instead of elevation.
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
      'inline-flex items-center justify-center gap-1.5 rounded-card px-3.5 py-2 text-[13px] font-semibold',
      'transition-colors disabled:cursor-not-allowed disabled:opacity-45',
      variant === 'default' && 'bg-primary text-white hover:bg-primary-strong',
      variant === 'outline' && 'border border-border-strong bg-surface text-ink hover:bg-surface-2',
      variant === 'ghost' && 'text-ink-muted hover:bg-surface-2 hover:text-ink',
      // Reserved for actions that cannot be undone. Red is the rubber stamp
      // that stops a document, so it must not appear anywhere it can be dismissed.
      variant === 'danger' && 'bg-rose text-white hover:brightness-95',
      className,
    )}
    {...props}
  />
));
Button.displayName = 'Button';
