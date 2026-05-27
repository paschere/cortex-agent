import type { ReactNode } from 'react';

export function Card({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border bg-white dark:bg-neutral-900 p-5 ${className}`}
    >
      {children}
    </div>
  );
}
