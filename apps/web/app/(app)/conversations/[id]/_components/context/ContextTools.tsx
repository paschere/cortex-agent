'use client';

import { toolDisplayName } from '@/lib/tool-labels';
import { clsx } from 'clsx';
import { useState } from 'react';
import { FAMILY_REASON, type FamilyView, SELECTION_REASON, type TurnView } from './types';

/**
 * Which tools the model was offered, and why those.
 *
 * THIS IS HALF-BUILT ALREADY AND WAS BEING THROWN AWAY. Tool selection is
 * semantic: every turn, each family of tools is scored for similarity against
 * what the person is asking for, the best ones travel and the rest are withheld
 * so the catalogue stays small enough for the model to choose well. That
 * ranking was computed on every turn and written to a debug log nobody reads.
 * Showing it is most of the work of explaining a turn — "it never called the
 * fleet tool because the fleet family scored 0,21 against your question" is an
 * answer; "it should have called the fleet tool" is a complaint.
 *
 * THE LOSERS ARE SHOWN. A family that scored just under the cut is the same
 * kind of evidence as a fragment that missed the floor by two thousandths, and
 * for the same reason: it names the thing that nearly happened. The scores
 * cannot be recovered later — the query vector is not stored and a tool's
 * vector is re-embedded whenever somebody edits its description — so they are
 * read off the row or they are gone.
 */

const LOCALE = 'es-CO';

function score(value: number | null): string {
  return value === null ? '—' : value.toFixed(3).replace('.', ',');
}

export function ContextTools({ turn }: { turn: TurnView }) {
  const [showAll, setShowAll] = useState(false);
  const { tools } = turn;

  // Families that travelled first, then the near misses. Within each half the
  // server already ordered by score.
  const offered = tools.families.filter((f) => f.offered);
  const withheld = tools.families.filter((f) => !f.offered);
  const visible = showAll ? withheld : withheld.slice(0, 4);

  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-xs font-bold text-ink">Las herramientas que se le ofrecieron</h4>
        <span className="tabular ml-auto text-micro text-ink-faint">
          {tools.offered.length.toLocaleString(LOCALE)} de{' '}
          {tools.candidates.toLocaleString(LOCALE)}
        </span>
      </div>
      <p className="mt-0.5 text-micro leading-relaxed text-ink-faint">
        {SELECTION_REASON[tools.reason]}
      </p>

      {tools.families.length > 0 && (
        <ul className="mt-2.5 space-y-1">
          {offered.map((f) => (
            <FamilyRow key={f.family} family={f} />
          ))}
          {withheld.length > 0 && (
            <li className="pt-1.5">
              <span className="text-micro font-semibold text-ink-faint">
                No se le ofrecieron
              </span>
            </li>
          )}
          {visible.map((f) => (
            <FamilyRow key={f.family} family={f} />
          ))}
          {withheld.length > visible.length && (
            <li>
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="text-micro font-semibold text-primary hover:underline"
              >
                Ver las otras {withheld.length - visible.length}
              </button>
            </li>
          )}
        </ul>
      )}

      {tools.offered.length > 0 && (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-micro font-semibold text-ink-muted hover:text-ink">
            Ver las {tools.offered.length.toLocaleString(LOCALE)} herramientas, una por una
          </summary>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {tools.offered.map((id) => (
              <span
                key={id}
                className="rounded-pill border border-border bg-surface-2 px-2 py-0.5 font-mono text-micro text-ink-muted"
                title={id}
              >
                {toolDisplayName(id.replaceAll('.', '_'))}
              </span>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function FamilyRow({ family }: { family: FamilyView }) {
  return (
    <li className="flex items-baseline gap-2">
      <span
        className={clsx(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          family.reason === 'muted'
            ? 'bg-rose'
            : family.offered
              ? 'bg-emerald'
              : 'bg-ink-faint/50',
        )}
      />
      <span
        className={clsx(
          'font-mono text-micro',
          family.offered ? 'text-ink' : 'text-ink-faint',
        )}
      >
        {family.family}
      </span>
      <span className="text-micro text-ink-faint">{FAMILY_REASON[family.reason]}</span>
      <span className="tabular ml-auto shrink-0 text-micro text-ink-muted">
        {score(family.score)}
      </span>
    </li>
  );
}
