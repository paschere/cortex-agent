import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('rounded-card border border-border bg-surface p-5', className)}>
      {children}
    </div>
  );
}
