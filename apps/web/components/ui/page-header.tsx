import type { ReactNode } from 'react';

/**
 * Consistent page identity; the primary action stays beside the heading.
 *
 * The self-service design wants the heading to do the talking: big, extrabold,
 * tight — 26px on a phone, 36px from tablet up — with the subtitle at reading
 * size underneath. Every page that uses this inherits it.
 */
export function PageHeader({
  title,
  subtitle,
  icon,
  actions,
}: { title: string; subtitle?: string; icon?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 items-start gap-4">
        {icon && (
          <span className="page-identity mt-0.5 hidden h-11 w-11 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary md:mt-1 md:grid">
            {icon}
          </span>
        )}
        <div className="min-w-0">
          <h1 className="page-heading text-balance text-xl font-extrabold text-ink md:text-display">
            {title}
          </h1>
          {subtitle && (
            <p className="page-subtitle mt-2 max-w-2xl text-pretty text-base leading-relaxed text-ink-muted">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
