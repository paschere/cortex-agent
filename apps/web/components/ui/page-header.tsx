import type { ReactNode } from 'react';

/**
 * Page title block: big title + subtitle on the left, actions on the right.
 * Matches the dashboard reference header.
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
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-center gap-3">
        {icon && (
          <span className="grid h-11 w-11 place-items-center rounded-[14px] bg-gradient-to-br from-primary to-primary-strong text-white shadow-pop">
            {icon}
          </span>
        )}
        <div>
          <h1 className="text-[22px] font-extrabold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-0.5 text-[13px] text-ink-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
