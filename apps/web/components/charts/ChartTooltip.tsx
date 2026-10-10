import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { DeltaPill } from './DeltaPill';

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
  /** Cambio frente a la serie de comparación (0,12 = +12 %). */
  delta?: number | null;
  /** Si subir es bueno (verde) o malo (rosa). `null` = neutro. */
  good?: boolean | null;
  muted?: boolean;
  /** Raya en vez de punto (series punteadas). */
  dashed?: boolean;
}

/**
 * La ficha que aparece sobre el gráfico: el rótulo del punto y una fila por
 * serie, con su color, su cifra y —si hay comparación— el cambio. Es HTML
 * (no SVG) para que el texto se parta y se lea igual que el resto de la app.
 */
export function ChartTooltip({
  title,
  rows,
  footer,
  className,
  style,
}: {
  title: string;
  rows: TooltipRow[];
  footer?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden
      className={clsx(
        'pointer-events-none z-10 min-w-[9.5rem] max-w-[15rem] rounded-sm border border-border bg-surface px-3 py-2 shadow-pop',
        className,
      )}
      style={style}
    >
      <p className="mb-1 text-micro font-semibold text-ink-muted">{title}</p>
      <ul className="space-y-0.5">
        {rows.map((r) => (
          <li
            key={r.label}
            className={clsx('flex items-center gap-2 text-xs', r.muted && 'text-ink-faint')}
          >
            {r.dashed ? (
              <span
                className="h-0 w-3 shrink-0 border-t-2 border-dashed"
                style={{ borderColor: r.color }}
              />
            ) : (
              <span
                className="h-2 w-2 shrink-0 rounded-pill"
                style={{ background: r.color ?? 'rgb(var(--ink-faint))' }}
              />
            )}
            <span className="min-w-0 flex-1 truncate text-ink-muted">{r.label}</span>
            <span
              className={clsx(
                'tabular shrink-0 tabular-nums font-semibold',
                r.muted ? 'text-ink-muted' : 'text-ink',
              )}
            >
              {r.value}
            </span>
            {r.delta !== undefined && <DeltaPill ratio={r.delta} good={r.good ?? null} compact />}
          </li>
        ))}
      </ul>
      {footer && <div className="mt-1 text-micro text-ink-faint">{footer}</div>}
    </div>
  );
}
