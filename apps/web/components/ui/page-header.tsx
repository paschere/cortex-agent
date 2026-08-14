import type { ReactNode } from 'react';

/**
 * Page heading: title and one line of context on the left, actions on the right.
 *
 * The icon sits in a soft brand-tinted tile rather than a flat square — at the
 * top of every screen it is the first thing seen, and it sets the register for
 * everything below it. No rule underneath: whitespace separates the header from
 * the content, which is what keeps the page feeling open.
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
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-center gap-3">
        {icon && (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-card bg-primary-soft text-primary ring-1 ring-inset ring-primary/10">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold tracking-[-0.02em] text-ink">{title}</h1>
          {subtitle && <p className="mt-1 text-sm leading-snug text-ink-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
