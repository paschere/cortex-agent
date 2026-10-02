import { Panel } from '@/components/ui/panel';
import { CHIP_TONE, type StatusTone } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { CircleSlash } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Las piezas que comparten las secciones del panel de Finanzas: el marco de
 * cada sección, el «sin dato» de una lectura que falló y los botones.
 */

export function Section({
  id,
  title,
  subtitle,
  icon,
  right,
  children,
  className,
}: {
  id?: string;
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = id ? `${id}-titulo` : undefined;
  return (
    <section id={id} aria-labelledby={headingId} className={clsx('scroll-mt-6', className)}>
      <Panel className="h-full p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {icon && (
              <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              <h2 id={headingId} className="text-lg font-extrabold text-ink">
                {title}
              </h2>
              {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
            </div>
          </div>
          {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
        </div>
        {children}
      </Panel>
    </section>
  );
}

/** La sección cuya lectura falló: «sin dato», con el motivo, sin romper la página. */
export function NoData({ reason }: { reason: string }) {
  return (
    <div className="flex items-start gap-3 rounded-sm bg-surface-2 px-4 py-3 text-xs text-ink-muted">
      <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
      <p>
        <span className="font-semibold text-ink">Sin dato.</span> {reason} Recarga la página en un
        momento.
      </p>
    </div>
  );
}

export const pillLink =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2';

export const pillPrimary =
  'cortex-primary-button inline-flex min-h-9 items-center justify-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-xs font-bold text-white transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50';

export const fieldClass =
  'min-h-10 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-primary/15';

/** Una nota de lo que pasó después de un botón, que el lector de pantalla anuncia. */
export function ActionNote({ note }: { note: { ok: boolean; text: string } | null }) {
  return (
    <output
      aria-live="polite"
      className={clsx('block text-xs', !note && 'sr-only', note?.ok ? 'text-emerald' : 'text-rose')}
    >
      {note?.text ?? ''}
    </output>
  );
}

/**
 * Un estado en cápsula, con los tonos de `lib/status-chip`. Base propia con
 * `text-micro`: el tamaño suelto de CHIP_BASE (11 px) vive en lib/, que
 * Tailwind no escanea, así que esa clase no se genera y la cápsula sale a 16px.
 */
export function statusPill(tone: StatusTone): string {
  return clsx(
    'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill border px-2.5 py-0.5 text-micro font-semibold',
    CHIP_TONE[tone],
  );
}
