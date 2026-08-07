'use client';

import { RailLegend, ScoreRail } from '@/app/(app)/kb/_components/bench/ScoreRail';
import { clsx } from 'clsx';
import { EyeOff, Lock, Scale } from 'lucide-react';
import { COVERAGE_LABEL, type FragmentView, type TurnView } from './types';

/**
 * The fragments of Brain Knowledge this turn was given — and the ones it was
 * not.
 *
 * IT IS THE SAME INSTRUMENT AS THE MEMORY BENCH, ON PURPOSE. `ScoreRail` and
 * `RailLegend` are imported from the bench rather than reimplemented, so a
 * fragment on this page and a fragment on the Brain Knowledge page are drawn by
 * the same code, on the same rail, at the same two cuts. Two rails that looked
 * alike and were drawn differently would be worse than one ugly rail: people
 * compare these screens, and the comparison has to hold.
 *
 * WHAT MAKES THIS PAGE DIFFERENT FROM THE BENCH. The bench probes: it asks what
 * retrieval WOULD return, right now, and it can be re-run. This is a record of
 * what retrieval DID return, on a turn that already happened, with the cuts
 * that were in force that day — which is why `cuts` comes off the stored row
 * and is passed into the rail, exactly as the bench passes its own. Since this
 * was written the thresholds have been recalibrated more than once; a rail
 * drawn at today's numbers over yesterday's scores is an instrument that lies.
 *
 * AND THE LINE. The bench draws "hasta aquí le llega a Cortex" at a fixed rank,
 * because it is predicting. Here it is not a prediction: every fragment knows
 * whether it was really pasted above the question, so the divider falls where
 * the truth put it.
 */

function score(value: number | null): string {
  return value === null ? '—' : value.toFixed(3).replace('.', ',');
}

export function ContextFragments({ turn }: { turn: TurnView }) {
  const { retrieval } = turn;

  if (!retrieval.ran) {
    return (
      <section>
        <h4 className="text-[12px] font-bold text-ink">Fragmentos del cerebro</h4>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
          En este turno no se buscó nada en Brain Knowledge.{' '}
          {retrieval.skipped && <span className="text-ink-faint">{retrieval.skipped}</span>}
        </p>
      </section>
    );
  }

  const prepended = retrieval.fragments.filter((f) => f.prepended);
  const rest = retrieval.fragments.filter((f) => !f.prepended);

  return (
    <section>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="text-[12px] font-bold text-ink">Fragmentos del cerebro</h4>
        <span className="tabular ml-auto text-[11px] text-ink-faint">
          {prepended.length} de {retrieval.fragments.length} le llegaron
        </span>
      </div>

      <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">
        <span className="font-semibold text-ink">{COVERAGE_LABEL[retrieval.coverage]}.</span>{' '}
        Buscó «{retrieval.query}».
      </p>

      {/* Printed as written, not paraphrased: this is the exact sentence Cortex
          was handed about its own results, and a second wording of it would
          eventually disagree with the first. */}
      {retrieval.summary && (
        <p className="mt-1.5 border-l-2 border-ink-faint/25 pl-2.5 text-[11.5px] italic leading-relaxed text-ink-muted">
          {retrieval.summary}
        </p>
      )}

      {!retrieval.cuts.measured && retrieval.cuts.modelId && (
        <p className="mt-2 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-[11.5px] leading-relaxed text-ink">
          Los cortes de este turno no estaban medidos para «{retrieval.cuts.modelId}». Eran un
          margen provisional y amplio, así que lee estos veredictos con pinzas.
        </p>
      )}

      {retrieval.fragments.length === 0 ? (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          No volvió ni un fragmento. Cortex contestó sin nada del cerebro encima.
        </p>
      ) : (
        <>
          <div className="mt-3 flex items-center gap-1.5 text-[11px] font-semibold text-ink-muted">
            <Scale className="h-3.5 w-3.5 text-ink-faint" />
            Qué tan cerca estaba cada fragmento de la pregunta
          </div>
          <div className="mt-2">
            <RailLegend cuts={retrieval.cuts} />
          </div>

          <ol className="mt-2 divide-y divide-border border-t border-border">
            {prepended.map((f, i) => (
              <li key={f.key}>
                <Row fragment={f} rank={i} cuts={retrieval.cuts} />
              </li>
            ))}
          </ol>

          {rest.length > 0 && (
            <>
              {/* The line this whole panel exists to draw. Above it is what
                  Cortex read; below it is material that was found, ranked, and
                  never shown to it — which is usually the answer. */}
              <div className="my-3 flex items-center gap-2">
                <span className="h-px flex-1 bg-border-strong" />
                <span className="whitespace-nowrap text-[10.5px] font-semibold text-ink-faint">
                  de aquí para abajo no le llegó
                </span>
                <span className="h-px flex-1 bg-border-strong" />
              </div>
              <ol className="divide-y divide-border border-t border-border">
                {rest.map((f, i) => (
                  <li key={f.key}>
                    <Row fragment={f} rank={prepended.length + i} cuts={retrieval.cuts} />
                  </li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </section>
  );
}

function Row({
  fragment,
  rank,
  cuts,
}: {
  fragment: FragmentView;
  rank: number;
  cuts: TurnView['retrieval']['cuts'];
}) {
  const faded = !fragment.prepended;

  return (
    <div className={clsx('flex items-start gap-3 py-2.5', faded && 'bg-surface-2/50')}>
      <span
        className={clsx(
          'stat-num mt-0.5 w-5 shrink-0 text-right text-[11.5px]',
          faded ? 'text-ink-faint' : 'text-primary',
        )}
      >
        {rank + 1}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="truncate text-[12px] font-semibold text-ink">
            {fragment.documentTitle}
          </span>
          <span className="tabular shrink-0 text-[10.5px] text-ink-faint">
            frag. {fragment.chunkIndex + 1}
          </span>
          <span className="inline-flex shrink-0 items-center gap-1 text-[10.5px] text-ink-faint">
            {fragment.spaceKind === 'personal' && <Lock className="h-2.5 w-2.5" />}
            {fragment.spaceName}
          </span>
        </div>

        {fragment.withheld ? (
          // The numbers survive, the quotation does not. See read.ts: being able
          // to open somebody's transcript is not the same as being handed the
          // contents of their private notes.
          <p className="mt-1 inline-flex items-center gap-1.5 text-[11.5px] italic text-ink-faint">
            <EyeOff className="h-3 w-3" />
            No puedes ver este espacio, así que el texto no se muestra.
          </p>
        ) : fragment.excerpt ? (
          <p
            className={clsx(
              'mt-1 whitespace-pre-wrap border-l-2 pl-2.5 text-[12.5px] leading-[1.65]',
              faded ? 'border-border text-ink-faint' : 'border-primary/25 text-ink',
            )}
          >
            {fragment.excerpt}
          </p>
        ) : (
          <p className="mt-1 text-[11.5px] italic text-ink-faint">
            El texto de este turno ya se borró por antigüedad. Los puntajes se quedan.
          </p>
        )}

        {faded && fragment.verdict === 'dropped' && (
          <p className="mt-1 text-[10.5px] font-semibold text-ink-faint">
            quedó por debajo del mínimo — no se le pudo citar
          </p>
        )}
        {faded && fragment.verdict !== 'dropped' && (
          <p className="mt-1 text-[10.5px] font-semibold text-ink-faint">
            pasó el mínimo pero no cupo en el cupo de fragmentos
          </p>
        )}
      </div>

      <div className="w-[132px] shrink-0 pt-0.5">
        <ScoreRail
          cosine={fragment.cosine}
          keyword={fragment.keyword}
          verdict={fragment.verdict}
          rank={rank}
          cuts={cuts}
        />
        <span className="sr-only">{score(fragment.cosine)}</span>
      </div>
    </div>
  );
}
