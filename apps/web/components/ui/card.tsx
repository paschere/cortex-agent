import type { ReactNode } from 'react';
import { clsx } from 'clsx';

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('rounded-card border border-border bg-surface p-5 shadow-card', className)}>
      {children}
    </div>
  );
}
