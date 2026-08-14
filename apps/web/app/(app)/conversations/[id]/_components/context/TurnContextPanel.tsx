'use client';

import { clsx } from 'clsx';
import { Brain, ChevronDown, FileClock, Layers, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { ContextFragments } from './ContextFragments';
import { ContextTiming } from './ContextTiming';
import { ContextTools } from './ContextTools';
import { ContextWeight } from './ContextWeight';
import type { TurnView } from './types';

/**
 * "Lo que recibió" — one assistant turn, opened up.
 *
 * WHY IT IS FOLDED AWAY BY DEFAULT. The transcript's job is the conversation.
 * This is the instrument you reach for when the conversation went wrong, and an
 * instrument permanently unfolded over every turn would bury the thing it is
 * annotating. The closed state still earns its line: it carries the two figures
 * that decide whether opening it is worth it — how many fragments reached the
 * model, and what the turn weighed.
 *
 * WHAT IT NEVER DOES. It does not re-run anything. Every number on it was
 * written down at the moment of the turn, and the only arithmetic between the
 * row and the screen is a share of a total. That is the whole promise of the
 * surface: a panel that recomputed would agree with the truth on every turn
 * except the ones somebody opened it for.
 */

const LOCALE = 'es-CO';

export function TurnContextPanel({ turn }: { turn: TurnView }) {
  const [open, setOpen] = useState(false);
  const { retrieval } = turn;

  return (
    <div className="mt-3 rounded-card border border-border bg-surface-2/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
      >
        <Layers className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
        <span className="text-xs font-semibold text-ink">Lo que recibió</span>

        <span className="tabular ml-auto flex shrink-0 items-center gap-2.5 text-micro text-ink-faint">
          {retrieval.ran && (
            <span title="Fragmentos del cerebro que le llegaron, de los que volvieron">
              {retrieval.prependedCount}/{retrieval.fragments.length} fragmentos
            </span>
          )}
          {turn.latency?.firstVisibleMs !== null && turn.latency !== null && (
            <span title="Cuánto esperó la persona antes de ver la primera letra">
              {turn.latency.firstVisibleMs < 1000
                ? `${turn.latency.firstVisibleMs} ms`
                : `${(turn.latency.firstVisibleMs / 1000).toLocaleString(LOCALE, { maximumFractionDigits: 1 })} s`}{' '}
              a la 1.ª letra
            </span>
          )}
          {turn.promptTokens !== null && (
            <span title="Tokens de entrada que reportó el proveedor">
              {turn.promptTokens.toLocaleString(LOCALE)} tokens
            </span>
          )}
          {turn.overridden && (
            <span
              className="inline-flex items-center gap-1 rounded-pill border border-amber/40 bg-amber-soft px-1.5 py-0.5 font-semibold text-amber"
              title="Este turno corrió con un ajuste puesto a mano en esta conversación"
            >
              <SlidersHorizontal className="h-2.5 w-2.5" />
              ajustado
            </span>
          )}
        </span>

        <ChevronDown
          className={clsx(
            'h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border px-3.5 py-3.5">
          {turn.redacted && (
            <p className="rounded-card border border-border bg-surface px-3 py-2 text-micro leading-relaxed text-ink-muted">
              <FileClock className="mr-1 inline h-3 w-3 text-ink-faint" />
              Este turno ya pasó de los catorce días, así que se borró el texto citado. Los
              puntajes, los veredictos y el peso siguen aquí — lo que no está es el contenido.
            </p>
          )}

          {turn.latency && <ContextTiming latency={turn.latency} />}
          <ContextWeight turn={turn} />
          <ContextFragments turn={turn} />
          <ContextTools turn={turn} />
          <Standing turn={turn} />
        </div>
      )}
    </div>
  );
}

/**
 * The memory and the instructions — the two parts that go in whole, every turn,
 * without anybody choosing them.
 *
 * The agent's own prompt is shown BY FINGERPRINT rather than by copy, and the
 * panel says whether it is still the same one. Reprinting today's prompt over
 * an old turn would be the easy version and a false one: that text is edited,
 * and it is edited most often precisely because a turn went wrong.
 */
function Standing({ turn }: { turn: TurnView }) {
  return (
    <section>
      <h4 className="text-xs font-bold text-ink">Lo que va siempre</h4>

      <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Brain className="h-3 w-3 text-ink-faint" />
        <span className="text-micro font-semibold text-ink-muted">Sus instrucciones</span>
        <span className="tabular text-micro text-ink-faint">
          {turn.instructions.chars.toLocaleString(LOCALE)} caracteres
        </span>
        {turn.instructions.unchanged === true && (
          <span className="text-micro text-ink-faint">· siguen siendo las mismas de hoy</span>
        )}
        {turn.instructions.unchanged === false && (
          <span className="text-micro font-semibold text-amber">
            · han cambiado desde este turno
          </span>
        )}
      </div>

      {turn.memories.length === 0 ? (
        <p className="mt-2 text-micro text-ink-faint">
          No tenía nada tuyo recordado en este turno.
        </p>
      ) : (
        <>
          <p className="mt-2 text-micro font-semibold text-ink-muted">
            Lo que recuerda de ti ({turn.memories.length})
          </p>
          <ul className="mt-1 space-y-1">
            {turn.memories.map((memory) => (
              <li
                key={memory.id}
                className="border-l-2 border-sky/30 pl-2.5 text-micro leading-relaxed text-ink-muted"
              >
                {memory.text ?? (
                  <span className="italic text-ink-faint">
                    (el texto ya se borró por antigüedad)
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
