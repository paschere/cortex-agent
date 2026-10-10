'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Target } from 'lucide-react';
import { DeltaPill } from '../../charts/DeltaPill';
import { Sparkline } from '../../charts/Sparkline';
import { axisFormatterFor } from '../../charts/scales';
import { Card, TONE_BAR, TONE_COLOR, TONE_SOFT } from './theme';

/**
 * LA CIFRA, Y EL KPI CONTRA EL PERÍODO ANTERIOR.
 *
 * Sin `compare`, la cifra de siempre: el número grande, la meta si la hay y
 * cuántas filas lo sostienen. Con `compare`, el número es el del período
 * («Este mes»), con una ficha que dice el cambio contra el anterior y una
 * línea con los últimos períodos debajo — el único dato con tiempo que trae
 * una cifra, así que la línea sólo sale cuando lo hay.
 *
 * El número va en tinta, grande y monoespaciado: es lo que se lee primero y
 * tiene que leerse igual en cualquier marca. El tono del bloque marca el punto
 * del título, la línea y la barra de la meta.
 *
 * El color de la flecha dice si el cambio es BUENO, no hacia dónde va: subir
 * las ventas es verde, subir las devoluciones es rosa (`goodWhen`). Y nunca
 * sólo el color: la flecha, el signo y la frase dicen lo mismo para quien no
 * distingue verde de rosa.
 */

type Metric = Extract<ComputedBlock, { type: 'metric' }>;

const STATUS_TONE = { good: 'emerald', warn: 'amber', bad: 'rose' } as const;
const STATUS_TEXT = { good: 'En meta', warn: 'Cerca', bad: 'Lejos' } as const;

const STATUS_TEXT_DOWN = {
  good: 'Bajo el tope',
  warn: 'Pasó el tope',
  bad: 'Muy sobre el tope',
} as const;

const PERCENT = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 });

export function MetricBlock({ block }: { block: Metric }) {
  const pct = block.goal ? Math.max(0, Math.min(block.goal.ratio, 1)) : 0;
  const compare = block.compare;
  // El semáforo sólo existe con meta: verde, ámbar o rojo, y siempre con texto.
  const status = block.goal?.status ?? null;
  // El tamaño sigue el ANCHO DE LA TARJETA, no la longitud del texto sola: una
  // cifra como «$ 168.200.000» cabe en media fila pero no en un tercio de un
  // teléfono. La tarjeta es contenedor (`container-type`) y la cifra toma lo
  // que quepa: la mono mide ~0,6 em por carácter, así que 150/largo en `cqi`
  // la deja dentro con margen, entre 1 rem y el tamaño de titular.
  const fit = `clamp(1rem, ${Math.max(4, Math.floor(150 / Math.max(block.display.length, 1)))}cqi, 2.25rem)`;
  return (
    <Card className="flex flex-col">
      <div className="flex items-center justify-between gap-2">
        <p className="flex min-w-0 items-center gap-2 text-xs font-semibold text-ink-muted">
          <span
            aria-hidden
            className={clsx('h-2 w-2 shrink-0 rounded-pill', TONE_BAR[block.tone])}
          />
          <span className="truncate">{block.title}</span>
        </p>
        {compare && (
          <span className="shrink-0 rounded-pill bg-surface-2 px-2.5 py-0.5 text-micro font-semibold text-ink-muted">
            {compare.currentLabel}
          </span>
        )}
      </div>
      <div className="mt-3" style={{ containerType: 'inline-size' }}>
        <p
          className="tabular whitespace-nowrap tabular-nums font-semibold leading-none tracking-tight text-ink"
          style={{ fontSize: fit }}
        >
          {block.display}
        </p>
      </div>
      {compare && <Trend compare={compare} />}
      {compare && compare.series.length >= 2 && (
        <div className="mt-auto pt-4">
          <Sparkline
            values={compare.series.map((x) => x.value)}
            labels={compare.series.map((x) => x.label)}
            color={TONE_COLOR[block.tone]}
            format={axisFormatterFor(block.display)}
            name={block.title}
            showLabels
          />
        </div>
      )}
      {block.goal ? (
        <div className="mt-auto pt-5">
          <div className="mb-1.5 flex items-center justify-between gap-2 text-micro">
            <span className="inline-flex flex-wrap items-center gap-1.5 font-semibold text-ink-muted">
              <span className="inline-flex items-center gap-1">
                <Target className="h-3.5 w-3.5" aria-hidden />
                {Math.round(block.goal.ratio * 100)} %{' '}
                {block.goal.direction === 'down' ? 'del tope' : 'de la meta'}
              </span>
              {status && (
                <span
                  className={clsx(
                    'inline-flex items-center gap-1 rounded-pill px-2 py-0.5',
                    TONE_SOFT[STATUS_TONE[status]],
                  )}
                >
                  <span
                    aria-hidden
                    className={clsx('h-1.5 w-1.5 rounded-pill', TONE_BAR[STATUS_TONE[status]])}
                  />
                  {block.goal?.direction === 'down'
                    ? STATUS_TEXT_DOWN[status]
                    : STATUS_TEXT[status]}
                </span>
              )}
            </span>
            <span className="tabular tabular-nums text-ink-faint">{block.goal.display}</span>
          </div>
          {/* biome-ignore lint/a11y/useFocusableInteractive: una barra de avance se lee, no se usa. */}
          <div
            role="progressbar"
            aria-label={`${block.title}: avance hacia la meta`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct * 100)}
            className="h-2 overflow-hidden rounded-pill bg-surface-2"
          >
            <div
              className={clsx(
                'view-grow-x h-full rounded-pill',
                status ? TONE_BAR[STATUS_TONE[status]] : TONE_BAR[block.tone],
              )}
              style={{ width: `${pct * 100}%` }}
            />
          </div>
        </div>
      ) : (
        !compare && (
          <p className="mt-auto pt-4 text-micro text-ink-faint">
            {block.caption ??
              `${block.rows} ${block.rows === 1 ? 'fila' : 'filas'} · ${block.source}`}
          </p>
        )
      )}
      {(compare || block.goal) && block.caption && (
        <p className="mt-2 text-micro leading-relaxed text-ink-faint">{block.caption}</p>
      )}
    </Card>
  );
}

function Trend({ compare }: { compare: NonNullable<Metric['compare']> }) {
  const delta =
    compare.delta === null
      ? compare.direction === 'flat'
        ? 'igual'
        : 'nuevo'
      : `${compare.delta > 0 ? '+' : ''}${PERCENT.format(compare.delta * 100)} %`;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-faint">
      <DeltaPill
        ratio={compare.delta === null ? (compare.direction === 'flat' ? 0 : null) : compare.delta}
        good={compare.good}
        text={delta.replace('-', '−')}
      />
      <span>
        {compare.previousLabel}{' '}
        <span className="tabular tabular-nums text-ink-muted">{compare.previousDisplay}</span>
      </span>
    </p>
  );
}
