'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Check, Target } from 'lucide-react';
import { Card, EmptyState, TONE_BAR, TONE_SOFT, useViewTheme } from './theme';

/**
 * EL AVANCE HACIA UNA META: una barra sola, o una por vendedor, sede, ruta o
 * curso. Lo que pasó la meta se pinta lleno y en verde con la frase «meta
 * superada» —no sólo con el color—; sin meta, cada barra se mide contra la
 * más grande y no se habla de porcentajes que no significan nada.
 */

type Progress = Extract<ComputedBlock, { type: 'progress' }>;

export function ProgressBlock({ block }: { block: Progress }) {
  const { density } = useViewTheme();
  return (
    <Card title={block.title} source={block.source}>
      {block.items.length === 0 ? (
        <EmptyState
          icon={<Target className="h-5 w-5" aria-hidden />}
          title="Todavía no hay datos"
          hint="El avance aparece cuando entren filas a la fuente."
        />
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
                {/* biome-ignore lint/a11y/useFocusableInteractive: una barra de avance se lee, no se usa; no va en el orden del teclado. */}
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
