import { clsx } from 'clsx';

export interface LegendItem {
  label: string;
  color: string;
  /** Forma de la muestra: cuadrito (barras), raya, raya punteada, banda o punto. */
  kind?: 'bar' | 'line' | 'dash' | 'band' | 'dot';
  /** Cifra o nota a la derecha (p. ej. «$ 48 M»). */
  value?: string;
}

/** La fila de leyenda: una muestra con la forma de la serie y su nombre. */
export function ChartLegend({
  items,
  className,
  label = 'Leyenda',
}: {
  items: LegendItem[];
  className?: string;
  label?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul
      className={clsx('flex flex-wrap gap-x-4 gap-y-1.5 text-micro text-ink-muted', className)}
      aria-label={label}
    >
      {items.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          <Swatch color={it.color} kind={it.kind ?? 'bar'} />
          <span>{it.label}</span>
          {it.value && <span className="tabular tabular-nums text-ink">{it.value}</span>}
        </li>
      ))}
    </ul>
  );
}

export function Swatch({ color, kind }: { color: string; kind: NonNullable<LegendItem['kind']> }) {
  return (
    <span aria-hidden className="inline-flex w-4 items-center justify-center">
      {kind === 'bar' && (
        <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} />
      )}
      {kind === 'dot' && <span className="h-2 w-2 rounded-pill" style={{ background: color }} />}
      {kind === 'line' && <span className="h-0.5 w-4 rounded-pill" style={{ background: color }} />}
      {kind === 'dash' && (
        <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: color }} />
      )}
      {kind === 'band' && (
        <span className="h-2.5 w-4 rounded-[3px]" style={{ background: color, opacity: 0.22 }} />
      )}
    </span>
  );
}
