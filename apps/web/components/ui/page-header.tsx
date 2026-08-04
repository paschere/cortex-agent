import type { ReactNode } from 'react';

/**
 * The heading of a section of the file: title and one line of context on the
 * left, the actions available on it to the right.
 *
 * Closed by a rule rather than announced by a gradient badge — a document
 * opens a section with a line across the page, and the badge was the last
 * place the old consumer look survived, inherited by every screen at once.
 * The icon stays, flat and quiet, because it aids recognition when the same
 * layout repeats across a dozen pages.
 */
export function PageHeader({
  title,
  subtitle,
  icon,
  actions,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4 border-b border-border-strong pb-4">
      <div className="flex items-center gap-3">
        {icon && (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card border border-primary/25 bg-primary-soft text-primary">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-[21px] font-bold tracking-[-0.01em] text-ink">{title}</h1>
          {subtitle && <p className="mt-1 text-[13px] leading-snug text-ink-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
