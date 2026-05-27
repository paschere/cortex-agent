import * as React from 'react';
import { clsx } from 'clsx';

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={clsx(
      'w-full rounded-lg border bg-transparent px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-300',
      className,
    )}
    {...props}
  />
));
Input.displayName = 'Input';
