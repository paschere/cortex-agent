'use client';

import { clsx } from 'clsx';
import type { LatencyView } from './types';

/**
 * "Cuánto tardó" — one turn's clock, opened up.
 *
 * WHAT IT LEADS WITH, AND WHY IT IS NOT THE TOTAL. The number that decides
 * whether Cortex feels alive is the time to the first character on screen, not
 * the time to the last one. A turn that starts writing at nine hundred
 * milliseconds and finishes at twenty seconds reads as fast; one that shows
 * nothing for eight seconds and finishes at twelve reads as broken, and the
 * person has already asked the colleague next to them. So the first figure is
 * the first character, the second is the first character of the ANSWER — which
 * on a turn that thinks out loud is a very different moment — and the total
 * comes third.
 *
 * WHY THE BARS START WHERE THEY START. Retrieval and the tool ranking run at
 * the same time, so their durations do not add up to the turn and a stacked bar
 * would be a lie. Each stage is drawn at the offset it really began at, which
 * makes the overlap something you can see rather than something you have to be
 * told. If a future change quietly puts them back in a queue, this drawing is
 * where it shows.
 *
 * Nothing here is computed from anything but the stored row.
 */

const LOCALE = 'es-CO';

/** Milliseconds, in the unit a person reads them in. */
function ms(value: number): string {
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} s`;
}

/** What each stage is called on screen. Unknown keys print themselves. */
const STAGE_NAMES: Record<string, string> = {
  setup: 'Preparación',
  retrieval: 'Brain Knowledge',
  selection: 'Elección de herramientas',
  history: 'Historial',
  prompt: 'Instrucciones',
  model: 'El modelo, hasta la primera letra',
  stream: 'Redacción y herramientas',
};

const STAGE_COLORS: Record<string, string> = {
  setup: 'bg-ink-faint/50',
  retrieval: 'bg-primary/70',
  selection: 'bg-amber/70',
  history: 'bg-ink-faint/50',
  prompt: 'bg-ink-faint/50',
  model: 'bg-primary',
  stream: 'bg-primary/40',
};

export function ContextTiming({ latency }: { latency: LatencyView }) {
  const span = Math.max(latency.totalMs, 1);
  // Sorted by when they began, so the column reads like the turn happened.
  const stages = [...latency.stages].sort((a, b) => a.at - b.at);

  return (
    <section>
      <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        Cuánto tardó
      </h4>

      <dl className="tabular mb-3 grid grid-cols-3 gap-2 text-[11.5px]">
        <div>
          <dt className="text-ink-faint">Primera letra</dt>
          <dd className="font-semibold text-ink">
            {latency.firstVisibleMs === null ? '—' : ms(latency.firstVisibleMs)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint" title="La primera letra de la respuesta, no del razonamiento">
            Primera letra de la respuesta
          </dt>
          <dd className="font-semibold text-ink">
            {latency.firstAnswerMs === null ? '—' : ms(latency.firstAnswerMs)}
          </dd>
        </div>
        <div>
          <dt className="text-ink-faint">Total</dt>
          <dd className="font-semibold text-ink">{ms(latency.totalMs)}</dd>
        </div>
      </dl>

      <ul className="space-y-1">
        {stages.map((s, i) => (
          <li key={`${s.stage}-${s.at}-${i}`} className="flex items-center gap-2">
            <span className="w-[168px] shrink-0 truncate text-[11px] text-ink-muted">
              {STAGE_NAMES[s.stage] ?? s.stage}
            </span>
            {/* The track is the whole turn; the bar sits where the stage really
                began. Two bars that start at the same x ran together. */}
            <span className="relative h-2 flex-1 overflow-hidden rounded-pill bg-surface">
              <span
                className={clsx(
                  'absolute inset-y-0 rounded-pill',
                  STAGE_COLORS[s.stage] ?? 'bg-ink-faint/50',
                )}
                style={{
                  left: `${(s.at / span) * 100}%`,
                  // A stage of a few milliseconds still has to be visible, or
                  // the fast ones read as "did not happen".
                  width: `${Math.max(0.8, (s.ms / span) * 100)}%`,
                }}
              />
            </span>
            <span className="tabular w-[62px] shrink-0 text-right text-[11px] text-ink-faint">
              {ms(s.ms)}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-2.5 text-[11px] leading-relaxed text-ink-muted">
        <span className="tabular font-semibold text-ink">{ms(latency.preludeMs)}</span> de esto es
        trabajo de Cortex antes de mandarle nada al modelo; el resto lo puso el modelo.{' '}
        {latency.steps > 1 ? (
          <>
            El turno dio <span className="tabular font-semibold text-ink">{latency.steps}</span>{' '}
            vueltas al modelo y llamó{' '}
            <span className="tabular font-semibold text-ink">{latency.toolCalls}</span> herramientas,
            que se llevaron <span className="tabular font-semibold text-ink">{ms(latency.toolMs)}</span>.
          </>
        ) : (
          <>Se resolvió en una sola vuelta al modelo, sin herramientas.</>
        )}{' '}
        {latency.cacheReadSteps > 0 ? (
          <>
            El caché de prompts sirvió{' '}
            <span className="tabular font-semibold text-ink">
              {latency.cacheTokensRead.toLocaleString(LOCALE)}
            </span>{' '}
            tokens en{' '}
            <span className="tabular font-semibold text-ink">{latency.cacheReadSteps}</span> de{' '}
            <span className="tabular font-semibold text-ink">{latency.steps}</span> vueltas.
          </>
        ) : (
          <>El caché de prompts no alcanzó a servir nada en este turno: se escribió de cero.</>
        )}
      </p>
    </section>
  );
}
