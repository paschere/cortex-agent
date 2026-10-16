'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Check, Target } from 'lucide-react';
import { useVariant } from './design';
import { Card, EmptyState, TONE_BAR, TONE_COLOR, TONE_SOFT, useViewTheme } from './theme';

/**
 * EL AVANCE HACIA UNA META: una barra sola, o una por vendedor, sede, ruta o
 * curso. Lo que pasó la meta se pinta lleno y en verde con la frase «meta
 * superada» —no sólo con el color—; sin meta, cada barra se mide contra la
 * más grande y no se habla de porcentajes que no significan nada.
 */

type Progress = Extract<ComputedBlock, { type: 'progress' }>;

export function ProgressBlock({ block }: { block: Progress }) {
  const { density } = useViewTheme();
  const variant = useVariant();
  return (
    <Card title={block.title} source={block.source}>
      {block.items.length === 0 ? (
        <EmptyState
          icon={<Target className="h-5 w-5" aria-hidden />}
          title="Todavía no hay datos"
          hint="El avance aparece cuando entren filas a la fuente."
        />
      ) : variant === 'ring' ? (
        <RingGrid block={block} />
      ) : (
        <ul className={density === 'compact' ? 'space-y-3' : 'space-y-4'}>
          {block.items.map((item, i) => {
            const done = !block.relative && item.target !== null && item.ratio >= 1;
            const width = Math.max(0, Math.min(item.ratio, 1)) * 100;
            return (
              <li key={item.label}>
                <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate font-semibold text-ink">{item.label}</span>
                  {item.target !== null && !block.relative ? (
                    <span
                      className={clsx(
                        'tabular inline-flex shrink-0 items-center gap-1 rounded-pill px-2 py-0.5 font-mono text-micro font-semibold',
                        done ? TONE_SOFT.emerald : 'bg-surface-2 text-ink-muted',
                      )}
                    >
                      {done && <Check className="h-3 w-3" aria-hidden />}
                      {Math.round(item.ratio * 100)} %
                    </span>
                  ) : null}
                </div>
                {variant === 'steps' ? (
                  <Steps item={item} done={done} tone={block.tone} />
                ) : (
                  // biome-ignore lint/a11y/useFocusableInteractive: una barra de avance se lee, no se usa; no va en el orden del teclado.
                  <div
                  role="progressbar"
                  aria-label={item.label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(width)}
                  aria-valuetext={
                    item.target === null
                      ? item.display
                      : `${Math.round(item.ratio * 100)} % de ${item.targetDisplay}`
                  }
                  className="h-2.5 overflow-hidden rounded-pill bg-surface-2"
                >
                  <div
                    className={clsx(
                      'view-grow-x h-full rounded-pill',
                      done ? 'bg-emerald' : TONE_BAR[block.tone],
                    )}
                    style={{ width: `${width}%`, animationDelay: `${i * 50}ms` }}
                  />
                </div>
                )}
                <p className="mt-1.5 flex items-baseline justify-between gap-3 text-micro">
                  <span className="tabular min-w-0 truncate font-mono text-ink-muted">
                    {item.display}
                    {item.targetDisplay && (
                      <span className="text-ink-faint"> de {item.targetDisplay}</span>
                    )}
                  </span>
                  {done ? (
                    <span className="shrink-0 font-semibold text-emerald">Meta superada</span>
                  ) : (
                    !block.relative &&
                    item.target === null && (
                      <span className="shrink-0 text-ink-faint">Sin meta</span>
                    )
                  )}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

type Item = Progress['items'][number];

const STEPS = 10;

/** PASOS: diez casillas; las del tramo cumplido van llenas. Sin meta, contra la mayor. */
function Steps({ item, done, tone }: { item: Item; done: boolean; tone: Progress['tone'] }) {
  const ratio = Math.max(0, Math.min(item.ratio, 1));
  const filled = ratio <= 0 ? 0 : Math.max(1, Math.round(ratio * STEPS));
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: un avance se lee, no se usa.
    <div
      role="progressbar"
      aria-label={item.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuetext={
        item.target === null
          ? item.display
          : `${filled} de ${STEPS} pasos, ${Math.round(item.ratio * 100)} % de ${item.targetDisplay}`
      }
      className="grid gap-1"
      style={{ gridTemplateColumns: `repeat(${STEPS}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: STEPS }, (_, n) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: la casilla ES la posición.
          key={n}
          className={clsx(
            'view-grow-x h-2.5 rounded-sm',
            n < filled ? (done ? 'bg-emerald' : TONE_BAR[tone]) : 'bg-surface-2',
          )}
          style={{ animationDelay: `${n * 25}ms` }}
        />
      ))}
    </div>
  );
}

/** ANILLOS: uno por ítem, con el % al centro y la etiqueta debajo. */
function RingGrid({ block }: { block: Progress }) {
  const R = 44;
  const C = 2 * Math.PI * R;
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3">
      {block.items.map((item) => {
        const done = !block.relative && item.target !== null && item.ratio >= 1;
        const ratio = Math.max(0, Math.min(item.ratio, 1));
        const hasPct = item.target !== null && !block.relative;
        return (
          <li key={item.label} className="flex min-w-0 flex-col items-center gap-2 text-center">
            {/* biome-ignore lint/a11y/useFocusableInteractive: un anillo de avance se lee, no se usa. */}
            <div
              role="progressbar"
              aria-label={item.label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(ratio * 100)}
              aria-valuetext={
                hasPct ? `${Math.round(item.ratio * 100)} % de ${item.targetDisplay}` : item.display
              }
              className="relative aspect-square w-full max-w-[6.5rem]"
            >
              <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden>
                <circle cx={50} cy={50} r={R} fill="none" className="stroke-surface-2" strokeWidth={10} />
                <circle
                  cx={50}
                  cy={50}
                  r={R}
                  fill="none"
                  stroke={done ? 'rgb(var(--emerald))' : TONE_COLOR[block.tone]}
                  strokeWidth={10}
                  strokeLinecap="round"
                  opacity={ratio <= 0 ? 0 : 1}
                  strokeDasharray={`${ratio * C} ${C}`}
                />
              </svg>
              <div className="absolute inset-[14%] grid place-items-center">
                <p className="tabular max-w-full truncate text-sm font-semibold leading-none tabular-nums text-ink">
                  {hasPct ? `${Math.round(item.ratio * 100)} %` : item.display}
                </p>
              </div>
            </div>
            <div className="min-w-0 max-w-full">
              <p className="truncate text-xs font-semibold text-ink">{item.label}</p>
              {hasPct && (
                <p className="tabular truncate text-micro text-ink-muted">
                  {item.targetDisplay ? `${item.display} de ${item.targetDisplay}` : item.display}
                </p>
              )}
              {done && <p className="text-micro font-semibold text-emerald">Meta superada</p>}
              {!block.relative && item.target === null && (
                <p className="text-micro text-ink-faint">Sin meta</p>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
