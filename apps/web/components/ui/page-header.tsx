import type { ReactNode } from 'react';

/** Consistent page identity; the primary action stays beside the heading. */
export function PageHeader({
  title,
  subtitle,
  icon,
  actions,
}: { title: string; subtitle?: string; icon?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-7 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface text-primary">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-ink">{title}</h1>
          {subtitle && (
            <p className="mt-1.5 max-w-2xl text-pretty text-sm leading-relaxed text-ink-muted">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
