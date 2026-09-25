import type { ComputedBlock, Tone } from '@cortex/agent-tools';
import { clsx } from 'clsx';

/**
 * Los tres gráficos de una vista, en SVG a mano.
 *
 * No hay librería de gráficos en la app (los informes también dibujan su SVG,
 * ver reports/charts.ts) y para tres formas no hacía falta traer una. El color
 * sale de los tokens por clase —`fill-primary`, `stroke-sky`— así que el mismo
 * gráfico se ve bien en el tema oscuro de la app y en el claro del enlace
 * público sin saber en cuál está.
 *
 * Cada gráfico lleva su lista de valores en texto debajo (o al lado, en la
 * dona): un gráfico es un dibujo de números y los números tienen que poder
 * leerse, copiarse y pasar por un lector de pantalla.
 */

type Chart = Extract<ComputedBlock, { type: 'chart' }>;

const FILL: Record<Tone, string> = {
  primary: 'fill-primary',
  emerald: 'fill-emerald',
  amber: 'fill-amber',
  sky: 'fill-sky',
  rose: 'fill-rose',
};
const STROKE: Record<Tone, string> = {
  primary: 'stroke-primary',
  emerald: 'stroke-emerald',
  amber: 'stroke-amber',
  sky: 'stroke-sky',
  rose: 'stroke-rose',
};
const BG: Record<Tone, string> = {
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  sky: 'bg-sky',
  rose: 'bg-rose',
};
const SERIES: Tone[] = ['primary', 'sky', 'emerald', 'amber', 'rose'];

export function ViewChart({ block }: { block: Chart }) {
  if (block.points.length === 0) {
    return <p className="py-8 text-center text-sm text-ink-faint">No hay filas que dibujar.</p>;
  }
  if (block.chart === 'donut') return <Donut block={block} />;
  if (block.chart === 'line') return <Line block={block} />;
  return <Bars block={block} />;
}

function Bars({ block }: { block: Chart }) {
  const max = Math.max(...block.points.map((p) => Math.abs(p.value)), 1);
  return (
    <ul className="space-y-2.5" aria-label={block.title}>
      {block.points.map((p) => (
        <li key={p.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-3">
          <span className="truncate text-xs text-ink-muted" title={p.label}>
            {p.label}
          </span>
          <span className="h-2.5 overflow-hidden rounded-pill bg-surface-2">
            <span
              className={clsx(
                'block h-full rounded-pill transition-[width] duration-500 ease-out',
                BG[block.tone],
              )}
              style={{ width: `${Math.max((Math.abs(p.value) / max) * 100, p.value ? 2 : 0)}%` }}
            />
          </span>
          <span className="tabular text-right font-mono text-xs text-ink">{p.display}</span>
        </li>
      ))}
    </ul>
  );
}

function Line({ block }: { block: Chart }) {
  const W = 600;
  const H = 180;
  const pad = 8;
  const values = block.points.map((p) => p.value);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = block.points.length > 1 ? (W - pad * 2) / (block.points.length - 1) : 0;
  const xy = block.points.map((p, i) => [
    pad + i * step,
    H - pad - ((p.value - min) / span) * (H - pad * 2),
  ]);
  const path = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x?.toFixed(1)},${y?.toFixed(1)}`).join(' ');
  const area = `${path} L${(pad + (xy.length - 1) * step).toFixed(1)},${H - pad} L${pad},${H - pad} Z`;
  const first = block.points[0];
  const last = block.points[block.points.length - 1];
  return (
    <figure>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-44 w-full overflow-visible"
        role="img"
        aria-label={`${block.title}: de ${first?.display} (${first?.label}) a ${last?.display} (${last?.label})`}
        preserveAspectRatio="none"
      >
        <path d={area} className={clsx(FILL[block.tone], 'opacity-10')} />
        <path
          d={path}
          className={clsx(STROKE[block.tone], 'fill-none')}
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <figcaption className="mt-2 flex justify-between text-micro text-ink-faint">
        <span>{first?.label}</span>
        <span className="tabular font-mono text-ink-muted">
          {last?.label}: {last?.display}
        </span>
      </figcaption>
    </figure>
  );
}

function Donut({ block }: { block: Chart }) {
  const total = block.points.reduce((a, p) => a + Math.max(p.value, 0), 0) || 1;
  const R = 42;
  const C = 2 * Math.PI * R;
  let offset = 0;
  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <svg
        viewBox="0 0 100 100"
        className="h-36 w-36 shrink-0 -rotate-90"
        role="img"
        aria-label={block.title}
      >
        <circle cx={50} cy={50} r={R} className="fill-none stroke-surface-2" strokeWidth={12} />
        {block.points.map((p, i) => {
          const len = (Math.max(p.value, 0) / total) * C;
          const el = (
            <circle
              key={p.label}
              cx={50}
              cy={50}
              r={R}
              className={clsx('fill-none', STROKE[SERIES[i % SERIES.length] ?? 'primary'])}
              strokeWidth={12}
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
            >
              <title>{`${p.label}: ${p.display}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
      </svg>
      <ul className="w-full min-w-0 space-y-1.5">
        {block.points.map((p, i) => (
          <li key={p.label} className="flex items-center gap-2 text-xs">
            <span
              className={clsx(
                'h-2.5 w-2.5 shrink-0 rounded-full',
                BG[SERIES[i % SERIES.length] ?? 'primary'],
              )}
            />
            <span className="min-w-0 flex-1 truncate text-ink-muted">{p.label}</span>
            <span className="tabular font-mono text-ink">{p.display}</span>
            <span className="tabular w-10 text-right font-mono text-ink-faint">
              {Math.round((Math.max(p.value, 0) / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
