'use client';

import { DEFAULT_CUTS, type RailCuts, railPosition } from '@/lib/kb-relevance-shape';
import { clsx } from 'clsx';
import { useEffect, useState } from 'react';
import { usePrefersReducedMotion } from '../motion';
import type { FragmentVerdict } from '../types';

/**
 * The rail: one measuring stick, shared by every fragment on screen.
 *
 * WHAT IT IS FOR. Retrieval already decides, on every question, which passages
 * are worth quoting and which are thrown away — and it decides on a number
 * nobody has ever been shown. Two cuts do all the work: a floor, below which a
 * passage is not offered as a citation at all, and a strong cut, above which it
 * is treated as actually answering the question. Those two numbers are the
 * difference between "Cortex didn't know" and "Cortex knew and dropped it", and
 * until now the only way to tell them apart was to guess.
 *
 * THE CUTS ARE PASSED IN, NOT IMPORTED. They depend on which embedding model
 * produced the scores — a cosine has no meaning without one — so the search
 * result carries the cuts that were really applied and the rail is engraved
 * with those. A rail drawn at hard-coded numbers while the verdicts came from
 * different ones is an instrument that lies, which is exactly how the document
 * this bench was built to find got thrown away without anybody seeing it.
 *
 * So the rail is drawn once, to a fixed scale, with both cuts engraved on it,
 * and every fragment is laid on the same rail. Fragments that cleared the bar
 * and fragments that did not appear on the identical instrument, which is what
 * makes the comparison mean anything — a bar that rescales per row is a bar
 * that can be read any way you like.
 *
 * WHY IT STOPS SHORT OF 1. See `kb-relevance-shape.ts`: real answers occupy a
 * narrow band well below 1,0, and a rail drawn to the full range squeezes that
 * band into its bottom half with the two cuts a hair apart.
 *
 * THE MOVEMENT. The bar grows from nothing to its length, staggered by rank, so
 * a result set arrives as a ranking being drawn rather than a table appearing.
 * It answers one question — in what order, and by how much did each clear the
 * bar — and it happens once per search. Under `prefers-reduced-motion` the bars
 * are simply their length from the first frame; nothing is lost but the reveal.
 */

function cutsOf(cuts: RailCuts) {
  return [
    { at: cuts.weakFloor, label: 'mínimo' },
    { at: cuts.strongMatch, label: 'responde' },
  ];
}

const FILL: Record<FragmentVerdict, string> = {
  strong: 'bg-emerald',
  weak: 'bg-amber',
  // No colour for what did not make it. Rose means blocked or overdue
  // everywhere else in Cortex, and a fragment that scored 0,41 is neither —
  // it simply is not evidence. Absence of colour says that better than a
  // warning colour would.
  dropped: 'bg-ink-faint',
};

export function ScoreRail({
  cosine,
  keyword,
  verdict,
  /** Position in the result set, used only to stagger the reveal. */
  rank = 0,
  /** Changes when a new search runs, so the bars redraw. */
  generation = 0,
  showScale = false,
  /** The cuts the retrieval really applied, from the model that scored it. */
  cuts = DEFAULT_CUTS,
}: {
  cosine: number | null;
  keyword: number;
  verdict: FragmentVerdict;
  rank?: number;
  generation?: number;
  showScale?: boolean;
  cuts?: RailCuts;
}) {
  const reduced = usePrefersReducedMotion();
  const [drawn, setDrawn] = useState(reduced);
  const position = railPosition(cosine, cuts.railCeiling);
  const marks = cutsOf(cuts);

  // Redraws on a new search and on nothing else. `generation` is the trigger:
  // the list re-renders whenever anything on the page changes, and bars that
  // reanimate because somebody hovered a row elsewhere read as a glitch.
  // biome-ignore lint/correctness/useExhaustiveDependencies: generation is the trigger
  useEffect(() => {
    if (reduced) {
      setDrawn(true);
      return;
    }
    setDrawn(false);
    // One frame at zero, then the length. Without the gap the browser coalesces
    // both styles into the same layout pass and there is nothing to transition.
    const raf = requestAnimationFrame(() => setDrawn(true));
    return () => cancelAnimationFrame(raf);
  }, [generation, reduced]);

  return (
    <div className="min-w-[132px] flex-1">
      <div className="relative h-[7px] w-full rounded-pill bg-surface-2">
        {/* The two cuts, engraved on the track itself so they sit under every
            bar rather than beside one of them. */}
        {marks.map((cut) => (
          <span
            key={cut.at}
            aria-hidden
            className="absolute top-[-2px] h-[11px] w-px bg-border-strong"
            style={{ left: `${(cut.at / cuts.railCeiling) * 100}%` }}
          />
        ))}

        {position !== null && (
          <span
            className={clsx(
              'absolute inset-y-0 left-0 rounded-pill',
              FILL[verdict],
              !reduced && 'transition-[width] duration-500 ease-out motion-reduce:transition-none',
            )}
            style={{
              width: `${(drawn ? position : 0) * 100}%`,
              transitionDelay: reduced ? undefined : `${Math.min(rank, 12) * 45}ms`,
            }}
          />
        )}
      </div>

      <div className="mt-1 flex items-baseline justify-between gap-2">
        {position === null ? (
          // Null is not zero. A cosine of zero is a measured certain miss; a
          // missing cosine means the semantic search never ran for this row,
          // and drawing it at the far left would be inventing a measurement.
          <span className="text-micro text-ink-faint">solo por palabras</span>
        ) : (
          <span className="tabular text-micro text-ink">
            {cosine?.toFixed(3).replace('.', ',')}
          </span>
        )}
        {keyword > 0 && (
          <span
            className="tabular text-micro text-ink-faint"
            title="Coincidencia literal de palabras"
          >
            +{keyword.toFixed(2).replace('.', ',')} palabras
          </span>
        )}
      </div>

      {showScale && (
        <div className="relative mt-1 h-[13px]" aria-hidden>
          {marks.map((cut) => (
            <span
              key={cut.at}
              className="absolute -translate-x-1/2 whitespace-nowrap text-micro text-ink-faint"
              style={{ left: `${(cut.at / cuts.railCeiling) * 100}%` }}
            >
              {cut.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The rail once, on its own, above a list — so the two cuts are named in words
 * exactly once instead of being repeated beside every row.
 */
export function RailLegend({ cuts = DEFAULT_CUTS }: { cuts?: RailCuts }) {
  const marks = cutsOf(cuts);
  return (
    <div className="flex items-end gap-3">
      <div className="min-w-0 flex-1">
        <div className="relative h-[7px] w-full rounded-pill bg-surface-2">
          {marks.map((cut) => (
            <span
              key={cut.at}
              aria-hidden
              className="absolute top-[-2px] h-[11px] w-px bg-border-strong"
              style={{ left: `${(cut.at / cuts.railCeiling) * 100}%` }}
            />
          ))}
        </div>
        <div className="relative mt-1 h-[26px] text-micro leading-tight text-ink-faint">
          <span className="absolute left-0">0</span>
          {marks.map((cut) => (
            <span
              key={cut.at}
              className="absolute -translate-x-1/2 text-center"
              style={{ left: `${(cut.at / cuts.railCeiling) * 100}%` }}
            >
              <span className="tabular block text-ink-muted">
                {cut.at.toFixed(2).replace('.', ',')}
              </span>
              {cut.label}
            </span>
          ))}
          <span className="tabular absolute right-0">
            {cuts.railCeiling.toFixed(2).replace('.', ',')}
          </span>
        </div>
      </div>
    </div>
  );
}
