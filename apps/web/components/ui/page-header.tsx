import type { ReactNode } from 'react';

/**
 * Page heading: title and one line of context on the left, actions on the right.
 *
 * It has to carry weight on 29 screens without becoming a box among boxes, so
 * the presence comes from two quiet things rather than a band: the icon sits
 * in the same white, glowing tile as the product's mark in the chat (surface +
 * shadow + brand ring, with a soft blur of indigo behind it), and the primary
 * action of the screen aligns to the right, at the same height as the title.
 * No background wash: a gradient clipped to a shallow box shows its edges on
 * the open canvas and reads as a highlight smudge — it was tried. And no rule
 * underneath: whitespace separates the header from the content, which is what
 * keeps the page feeling open.
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
    <header className="mb-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
      <div className="flex min-w-0 items-center gap-4">
        {icon && (
          <span className="relative grid h-12 w-12 shrink-0 place-items-center">
            {/* The glow paints outside its box but takes no layout space, so it
                cannot push a scrollbar the way a negative inset would. */}
            <span
              aria-hidden
              className="absolute inset-1 rounded-card bg-primary/25 opacity-60 blur-lg"
            />
            <span className="relative grid h-12 w-12 place-items-center rounded-card bg-surface text-primary shadow-card ring-1 ring-inset ring-primary/15">
              {icon}
            </span>
          </span>
        )}
        <div className="min-w-0">
          <h1 className="text-xl font-extrabold tracking-[-0.02em] text-ink">{title}</h1>
          {subtitle && (
            <p className="mt-1 max-w-2xl text-pretty text-sm leading-snug text-ink-muted">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
