'use client';

import { clsx } from 'clsx';
import { PART_FILL, PART_LABEL, PART_NOTE, type PartView, type TurnView } from './types';

/**
 * Where the context went — one bar, then the ledger under it.
 *
 * THE QUESTION IT ANSWERS. "It got forty thousand tokens and thirty of them
 * were tool descriptions" is invisible in every other view of a turn, and it is
 * the single most common reason a good model gives a poor answer: the thing it
 * needed was in there, buried under nine tenths of something else. So the bar
 * is one continuous strip rather than six separate meters — the parts compete
 * for one budget, and a strip is the only shape that says so.
 *
 * THE TWO KINDS OF NUMBER ARE KEPT APART, DELIBERATELY. Characters are
 * measured: that is the exact length of the text that was concatenated into the
 * request, and the shares are computed on it, so a percentage here is a fact.
 * Tokens are estimated from characters, and every one of them is printed next
 * to the word "aprox." The turn's REAL prompt token count comes from the
 * provider and is printed on its own, once, as the only unqualified figure.
 *
 * Making the estimate look exact would be the easy version of this panel and
 * the wrong one: somebody would eventually reconcile these numbers against a
 * bill, find they disagree, and stop trusting the whole screen — including the
 * parts that are exact.
 */

const LOCALE = 'es-CO';

function num(value: number): string {
  return value.toLocaleString(LOCALE);
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function ContextWeight({ turn }: { turn: TurnView }) {
  const parts = [...turn.parts].sort((a, b) => b.chars - a.chars);
  if (parts.length === 0) return null;

  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-[12px] font-bold text-ink">El peso</h4>
        {turn.promptTokens !== null ? (
          <span className="tabular ml-auto text-[11px] text-ink-muted">
            {num(turn.promptTokens)} tokens de entrada
          </span>
        ) : (
          <span className="ml-auto text-[11px] text-ink-faint">sin conteo del proveedor</span>
        )}
      </div>
      <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">
        Los porcentajes son exactos: se miden sobre los caracteres del texto que se envió. Los
        tokens de cada parte son aproximados; el único conteo real es el de arriba, que lo reporta
        el proveedor, y cubre además el andamiaje de las herramientas que aquí no se desglosa.
      </p>

      {/* One strip, because the parts share one budget. */}
      <div className="mt-2.5 flex h-2.5 w-full overflow-hidden rounded-pill bg-surface-2">
        {parts.map((part) => (
          <span
            key={part.key}
            className={clsx(PART_FILL[part.key], 'h-full')}
            style={{ width: `${part.share * 100}%` }}
            title={`${PART_LABEL[part.key]} · ${pct(part.share)}`}
          />
        ))}
      </div>

      <ul className="mt-2.5 space-y-1.5">
        {parts.map((part) => (
          <Row key={part.key} part={part} biggest={part.key === turn.heaviest} />
        ))}
      </ul>
    </section>
  );
}

function Row({ part, biggest }: { part: PartView; biggest: boolean }) {
  return (
    <li className="flex items-baseline gap-2.5">
      <span className={clsx('mt-1 h-2 w-2 shrink-0 rounded-full', PART_FILL[part.key])} />
      <span className="min-w-0 flex-1">
        <span
          className={clsx(
            'text-[12px]',
            biggest ? 'font-bold text-ink' : 'font-semibold text-ink-muted',
          )}
        >
          {PART_LABEL[part.key]}
        </span>
        <span className="ml-2 text-[11px] text-ink-faint">{PART_NOTE[part.key]}</span>
      </span>
      <span className="tabular shrink-0 text-[11.5px] font-semibold text-ink">
        {pct(part.share)}
      </span>
      <span className="tabular w-[92px] shrink-0 text-right text-[10.5px] text-ink-faint">
        ~{num(part.tokens)} tokens
      </span>
    </li>
  );
}
