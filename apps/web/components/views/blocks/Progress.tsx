'use client';

import type { ComputedBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Card, TONE_BAR, useViewTheme } from './theme';

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
        <p className="py-6 text-center text-sm text-ink-faint">Todavía no hay datos.</p>
      ) : (
        <ul className={density === 'compact' ? 'space-y-2' : 'space-y-3'}>
          {block.items.map((item) => {
            const done = !block.relative && item.target !== null && item.ratio >= 1;
            const width = Math.max(0, Math.min(item.ratio, 1)) * 100;
            return (
              <li key={item.label}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 truncate font-medium text-ink">{item.label}</span>
                  <span className="tabular shrink-0 font-mono text-ink-muted">
                    {item.display}
                    {item.targetDisplay && (
                      <span className="text-ink-faint"> / {item.targetDisplay}</span>
                    )}
                  </span>
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
                  className="h-2 overflow-hidden rounded-pill bg-surface-2"
                >
                  <div
                    className={clsx(
                      'h-full rounded-pill transition-[width] duration-500 ease-out',
                      done ? 'bg-emerald' : TONE_BAR[block.tone],
                    )}
                    style={{ width: `${width}%` }}
                  />
                </div>
                {item.target !== null && (
                  <p
                    className={clsx(
                      'mt-0.5 text-micro',
                      done ? 'font-semibold text-emerald' : 'text-ink-faint',
                    )}
                  >
                    {done ? 'Meta superada' : `${Math.round(item.ratio * 100)} % de la meta`}
                  </p>
                )}
                {!block.relative && item.target === null && (
                  <p className="mt-0.5 text-micro text-ink-faint">Sin meta</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
