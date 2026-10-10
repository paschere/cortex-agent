'use client';

import { clsx } from 'clsx';
import { useState } from 'react';
import { ChartEmpty } from './ChartEmpty';
import { formatDelta, segmentShares } from './scales';

export interface SegmentItem {
  key: string;
  label: string;
  value: number;
  /** La cifra tal como se escribe («$ 12,4 M»). */
  display: string;
  color: string;
}

/**
 * Una sola barra segmentada (2 px entre tramos) y debajo la leyenda con las
 * cifras. Sirve para antigüedad de cartera, composición, estados… Pasar por un
 * tramo o por su fila apaga el resto.
 */
export function SegmentBar({
  items,
  total,
  totalLabel = 'Total',
  height = 14,
  className,
  name = 'Composición',
  emptyNote = 'Sin datos suficientes',
}: {
  items: SegmentItem[];
  /** Cifra del total para el encabezado (opcional). */
  total?: string;
  totalLabel?: string;
  height?: number;
  className?: string;
  name?: string;
  emptyNote?: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const segs = segmentShares(items.map((i) => ({ key: i.key, value: i.value })));
  if (segs.length === 0) return <ChartEmpty note={emptyNote} height={96} className={className} />;
  const byKey = new Map(items.map((i) => [i.key, i]));
  const summary = `${name}: ${items
    .filter((i) => i.value > 0)
    .map(
      (i) => `${i.label} ${i.display} (${formatDelta(segShare(segs, i.key)).replace(/^[+−]/, '')})`,
    )
    .join(', ')}.`;
  return (
    <div className={className}>
      {total && (
        <p className="mb-2 flex items-baseline justify-between gap-2 text-xs">
          <span className="text-ink-muted">{totalLabel}</span>
          <span className="tabular tabular-nums font-semibold text-ink">{total}</span>
        </p>
      )}
      <div
        className="flex w-full gap-[2px]"
        style={{ height }}
        role="img"
        aria-label={summary}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: se puede recorrer con Tab para leer cada tramo.
        tabIndex={0}
      >
        {segs.map((s, i) => {
          const it = byKey.get(s.key);
          return (
            <span
              key={s.key}
              title={`${it?.label}: ${it?.display} · ${Math.round(s.share * 100)} %`}
              onPointerEnter={() => setHover(s.key)}
              onPointerLeave={() => setHover(null)}
              className={clsx(
                'cx-grow-x block h-full min-w-[3px] transition-opacity duration-150',
                i === 0 ? 'rounded-l-pill' : 'rounded-l-[3px]',
                i === segs.length - 1 ? 'rounded-r-pill' : 'rounded-r-[3px]',
              )}
              style={{
                flexGrow: s.size,
                flexBasis: 0,
                background: it?.color,
                opacity: hover === null || hover === s.key ? 1 : 0.3,
                animationDelay: `${i * 50}ms`,
              }}
            />
          );
        })}
      </div>
      <ul className="mt-3 grid gap-x-5 gap-y-1 sm:grid-cols-2">
        {items.map((it) => {
          const share = segShare(segs, it.key);
          return (
            <li
              key={it.key}
              onPointerEnter={() => setHover(it.key)}
              onPointerLeave={() => setHover(null)}
              className={clsx(
                'grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-sm px-1.5 py-1 text-xs transition-colors duration-150',
                hover === it.key && 'bg-surface-2',
                it.value <= 0 && 'opacity-55',
              )}
            >
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-[3px]"
                style={{ background: it.color }}
              />
              <span className="truncate text-ink-muted">{it.label}</span>
              <span className="tabular tabular-nums font-semibold text-ink">{it.display}</span>
              <span className="tabular w-9 text-right tabular-nums text-micro text-ink-faint">
                {Math.round(share * 100)} %
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function segShare(segs: ReturnType<typeof segmentShares>, key: string): number {
  return segs.find((s) => s.key === key)?.share ?? 0;
}

/**
 * Sólo la tira segmentada (con sus 2 px entre tramos), para quien ya trae su
 * propia leyenda en filas.
 */
export function SegmentStrip({
  items,
  height = 10,
  name = 'Composición',
  className,
}: {
  items: Array<{ key: string; label: string; value: number; display: string; color: string }>;
  height?: number;
  name?: string;
  className?: string;
}) {
  const segs = segmentShares(items.map((i) => ({ key: i.key, value: i.value })));
  const byKey = new Map(items.map((i) => [i.key, i]));
  return (
    <div
      className={clsx('flex w-full gap-[2px]', className)}
      style={{ height }}
      role="img"
      aria-label={`${name}: ${items
        .filter((i) => i.value > 0)
        .map((i) => `${i.label} ${i.display}`)
        .join(', ')}`}
    >
      {segs.map((s, i) => {
        const it = byKey.get(s.key);
        return (
          <span
            key={s.key}
            title={`${it?.label}: ${it?.display}`}
            className={clsx(
              'cx-grow-x block h-full min-w-[3px]',
              i === 0 ? 'rounded-l-pill' : 'rounded-l-[3px]',
              i === segs.length - 1 ? 'rounded-r-pill' : 'rounded-r-[3px]',
            )}
            style={{
              flexGrow: s.size,
              flexBasis: 0,
              background: it?.color,
              animationDelay: `${i * 50}ms`,
            }}
          />
        );
      })}
    </div>
  );
}
