'use client';

import { Provenance } from '@/components/ui/provenance';
import type { RailCuts } from '@/lib/kb-relevance-shape';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  CornerDownLeft,
  Loader2,
  Scale,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
// A server action, so importing it here does not drag the tools package into
// the browser bundle — see apps/web/lib/commitments-shape.ts for the trap.
import { noteFragmentCopied } from '../../../learning/actions';
import { probeMemory } from '../../actions';
import { num } from '../format';
import type { ProbeFragment, ProbeResult, SpaceSummary } from '../types';
import { RailLegend, ScoreRail } from './ScoreRail';

/**
 * The memory bench: ask a real question, watch the retrieval work, spend
 * nothing.
 *
 * WHY THIS IS THE FIRST THING ON THE PAGE. Every other complaint about an
 * assistant collapses into one sentence — "it answered wrong" — and there has
 * never been a way to find out whether retrieval brought back the wrong
 * material or the model misread the right material. This is that instrument.
 * The same `searchSpaces` the agent calls, the same relevance cuts, the same
 * conflict check, with every score on show and, crucially, WITH THE FRAGMENTS
 * IT THREW AWAY still on screen. Those are usually the answer: the passage was
 * there, the chunker cut it in half, and half of it scored 0,43.
 *
 * No model is called. Nothing is generated. Everything here is a row and a
 * number, which is the only reason it can be trusted as evidence.
 */

const EXAMPLES = [
  '¿qué quedamos con Coltrans sobre los sábados?',
  '¿cómo se liquida una importación?',
  'tarifa de bodegaje',
];

const COVERAGE: Record<ProbeResult['coverage'], { title: string; tone: string; dot: string }> = {
  answered: {
    title: 'Sí sabe esto',
    tone: 'border-emerald/30 bg-emerald-soft',
    dot: 'bg-emerald',
  },
  thin: {
    title: 'Solo tiene algo parecido',
    tone: 'border-amber/30 bg-amber-soft',
    dot: 'bg-amber',
  },
  nothing: {
    title: 'No tiene nada de esto',
    tone: 'border-border bg-surface-2',
    dot: 'bg-ink-faint',
  },
  'keyword-only': {
    title: 'Solo pudo buscar por palabras',
    tone: 'border-amber/30 bg-amber-soft',
    dot: 'bg-amber',
  },
};

export function MemoryBench({
  spaces,
  scopeId,
  onScopeChange,
  onProbe,
  onOpenFragment,
}: {
  spaces: SpaceSummary[];
  /** Which space to look in. Empty means everything this person can see. */
  scopeId: string;
  onScopeChange: (id: string) => void;
  /** Hands the result up so the map can light where the answer lives. */
  onProbe: (probe: ProbeResult | null) => void;
  onOpenFragment: (documentId: string, chunkIndex: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped per search so the rails redraw for a new answer and only then.
  const [generation, setGeneration] = useState(0);
  const ticket = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const run = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      ticket.current += 1;
      const mine = ticket.current;
      setRunning(true);
      setError(null);
      const res = await probeMemory(trimmed, scopeId || undefined);
      // Somebody has asked something else since. This answer is about an older
      // question and must not overwrite the newer one.
      if (ticket.current !== mine) return;
      setRunning(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setProbe(res.probe);
      setGeneration((g) => g + 1);
      onProbe(res.probe);
    },
    [scopeId, onProbe],
  );

  // Re-running on a scope change rather than leaving a stale answer labelled
  // with the wrong scope: the results on screen would be answering a question
  // about a different set of spaces than the one the selector says.
  const lastScope = useRef(scopeId);
  useEffect(() => {
    if (lastScope.current === scopeId) return;
    lastScope.current = scopeId;
    if (probe) void run(probe.query);
  }, [scopeId, probe, run]);

  const clear = useCallback(() => {
    ticket.current += 1;
    setQuery('');
    setProbe(null);
    setError(null);
    setRunning(false);
    onProbe(null);
    inputRef.current?.focus();
  }, [onProbe]);

  const window = probe?.window ?? 5;
  const reached = probe?.fragments.filter((f) => f.inWindow && f.verdict !== 'dropped').length ?? 0;

  return (
    <div className="flex min-h-0 flex-col">
      {/* ------------------------------------------------------------ ask */}
      <form
        className="px-4 pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run(query);
        }}
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="¿Qué quedamos con Coltrans sobre los sábados?"
            aria-label="Pregúntale a la memoria"
            className="h-11 w-full rounded-pill border border-border bg-surface-2 pl-10 pr-24 text-sm text-ink shadow-card transition-colors placeholder:text-ink-faint focus:border-primary/40 focus:bg-surface"
          />
          <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
            {(query || probe) && (
              <button
                type="button"
                onClick={clear}
                aria-label="Limpiar la prueba"
                className="rounded-pill p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              type="submit"
              disabled={running || !query.trim()}
              className="inline-flex h-8 items-center gap-1.5 rounded-pill bg-primary px-3.5 text-xs font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-40 disabled:shadow-none"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              ) : (
                <CornerDownLeft className="h-3.5 w-3.5" />
              )}
              Probar
            </button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <p className="text-micro text-ink-faint">
            Te muestro los fragmentos exactos que recuperaría, en su orden y con su puntaje. No
            gasta una respuesta.
          </p>
          {spaces.length > 1 && (
            <select
              value={scopeId}
              onChange={(e) => onScopeChange(e.target.value)}
              aria-label="Dónde buscar"
              className="ml-auto h-7 rounded-pill border border-border bg-surface px-2.5 text-micro font-medium text-ink-muted focus:border-border-strong"
            >
              <option value="">En todo lo que ves</option>
              {spaces.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </form>

      {error && (
        <p className="mx-4 mt-3 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose">
          {error}
        </p>
      )}

      {/* --------------------------------------------------------- nothing yet */}
      {!probe && !error && (
        <div className="px-4 py-5">
          <p className="text-xs leading-relaxed text-ink-muted">
            Escribe una pregunta de verdad — de las que alguien le hace a Cortex un martes. Si lo
            que sale aquí no sirve, la respuesta tampoco iba a servir.
          </p>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  setQuery(example);
                  void run(example);
                }}
                className="rounded-pill border border-border bg-surface px-3 py-1.5 text-micro text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ verdict */}
      {probe && (
        <div className="min-h-0 flex-1 overflow-y-auto scroll-slim">
          <div className="px-4 pt-4">
            <div className={clsx('rounded-card border px-3.5 py-3', COVERAGE[probe.coverage].tone)}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className={clsx('h-2 w-2 rounded-full', COVERAGE[probe.coverage].dot)} />
                <span className="text-sm font-bold text-ink">
                  {COVERAGE[probe.coverage].title}
                </span>
                <span className="tabular ml-auto text-micro text-ink-faint">
                  {num(probe.elapsedMs)} ms · {num(reached)}/{num(window)} citables
                </span>
              </div>
              {/*
                Not a paraphrase. This is the exact sentence Cortex is handed
                about its own results, printed as it is written — because what
                the model is told is itself a thing worth being able to read,
                and a second wording of it would eventually disagree.
              */}
              <p className="mt-1.5 border-l-2 border-ink-faint/25 pl-2.5 text-xs italic leading-relaxed text-ink-muted">
                {probe.summary}
              </p>
            </div>

            {!probe.scale.measured && (
              <p className="mt-2 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-micro leading-relaxed text-ink">
                Los cortes de esta regla no están medidos para «{probe.scale.modelId}», el modelo de
                embeddings que está corriendo. Son un margen provisional y amplio: lee estos
                veredictos con pinzas y no tomes un «no hay nada» como prueba de que no hay nada.
              </p>
            )}

            {probe.degraded && (
              <p className="mt-2 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-micro leading-relaxed text-ink">
                {probe.degraded} Que no aparezca algo aquí no prueba que no esté guardado.
              </p>
            )}
          </div>

          {/* ------------------------------------------------------ conflicts */}
          {probe.conflicts.length > 0 && (
            <div className="mt-3 px-4">
              {probe.conflicts.map((c) => (
                <div
                  key={`${c.documentTitle}-${c.otherDocumentTitle}-${c.similarity}`}
                  className="mb-2 rounded-card border border-rose/30 bg-rose-soft px-3.5 py-3"
                >
                  <div className="flex items-center gap-1.5 text-xs font-bold text-rose">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Dos documentos dicen cosas distintas
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-ink">{c.note}</p>
                  <p className="mt-1.5 line-clamp-3 border-l-2 border-rose/30 pl-2.5 text-micro leading-relaxed text-ink-muted">
                    {c.otherContent}
                  </p>
                  <p className="mt-1 text-micro text-ink-faint">
                    «{c.otherDocumentTitle}» en {c.otherSpace} ·{' '}
                    {c.moreRecent === 'other' ? 'es el más reciente' : 'es el más viejo'}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* ------------------------------------------------------ the rail */}
          {probe.fragments.length > 0 && (
            <div className="mt-4 px-4">
              <div className="flex items-center gap-1.5 text-micro font-semibold text-ink-muted">
                <Scale className="h-3.5 w-3.5 text-ink-faint" />
                Qué tan cerca está cada fragmento de tu pregunta
              </div>
              <div className="mt-2">
                <RailLegend cuts={probe.scale} />
              </div>
            </div>
          )}

          <ol className="mt-1">
            {probe.fragments.map((fragment, rank) => (
              <li key={fragment.chunkId || `${fragment.documentId}-${fragment.chunkIndex}`}>
                {rank === window && (
                  // The line the whole panel exists to draw. Above it is what
                  // Cortex is handed; below it is material that was found,
                  // ranked, and never shown to it.
                  <div className="mx-4 my-3 flex items-center gap-2">
                    <span className="h-px flex-1 bg-border-strong" />
                    <span className="whitespace-nowrap text-micro font-semibold text-ink-faint">
                      hasta aquí le llega a Cortex
                    </span>
                    <span className="h-px flex-1 bg-border-strong" />
                  </div>
                )}
                <Row
                  fragment={fragment}
                  rank={rank}
                  generation={generation}
                  cuts={probe.scale}
                  onOpen={() => onOpenFragment(fragment.documentId, fragment.chunkIndex)}
                />
              </li>
            ))}
          </ol>

          {probe.fragments.length === 0 && (
            <p className="px-4 py-6 text-xs leading-relaxed text-ink-muted">
              No recuperó ni un fragmento. Cortex diría que no sabe — y esa es la respuesta
              correcta. Si creías que sí lo sabía, es que lo que lo dice no está guardado, o entró
              con otras palabras.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  fragment,
  rank,
  generation,
  cuts,
  onOpen,
}: {
  fragment: ProbeFragment;
  rank: number;
  generation: number;
  /** The cuts this probe was really judged with — see ProbeResult.scale. */
  cuts: RailCuts;
  onOpen: () => void;
}) {
  const dropped = fragment.verdict === 'dropped';
  const stale = fragment.freshness === 'expired' || fragment.freshness === 'superseded';

  return (
    <div
      className={clsx(
        'border-t border-border px-4 py-3 transition-colors',
        dropped ? 'bg-surface-2/60' : 'hover:bg-surface-2',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={clsx(
            'stat-num mt-0.5 w-6 shrink-0 text-right text-xs',
            dropped ? 'text-ink-faint' : 'text-primary',
          )}
        >
          {rank + 1}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <button
              type="button"
              onClick={onOpen}
              className="group inline-flex min-w-0 items-center gap-1 text-left"
            >
              <span className="truncate text-xs font-semibold text-ink group-hover:underline">
                {fragment.documentTitle}
              </span>
              <ArrowRight className="h-3 w-3 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
            <span className="tabular shrink-0 text-micro text-ink-faint">
              frag. {num(fragment.chunkIndex + 1)}
            </span>
            <span className="truncate text-micro text-ink-faint">· {fragment.spaceName}</span>
          </div>

          {/*
            The specimen. This is the one comfortable reading size on a page of
            eleven-pixel chrome, and the inversion is deliberate: everything
            that MEASURES the fragment is small and monospaced, the fragment
            itself is prose you can actually read. It is the only thing here
            that is not a number.
          */}
          <p
            className={clsx(
              'mt-1.5 whitespace-pre-wrap border-l-2 pl-3 text-sm leading-[1.7]',
              dropped ? 'border-border text-ink-faint' : 'border-primary/25 text-ink',
            )}
          >
            {fragment.content.length > 460
              ? `${fragment.content.slice(0, 460).trimEnd()}…`
              : fragment.content}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {/* Provenance earns its place where the fragment really came from
                somewhere: a voice, at a minute, on a date. An uploaded page's
                provenance is the filename already printed above it, so it gets
                no stamp — an empty one devalues every real one. */}
            {fragment.speaker && (
              <Provenance
                source={fragment.speaker}
                readAt={fragment.spokenAt ?? undefined}
                detail={fragment.age ?? undefined}
                tone={stale ? 'seal' : 'stamp'}
              />
            )}
            {!fragment.speaker && fragment.age && (
              <span className={clsx('text-micro', stale ? 'text-rose' : 'text-ink-faint')}>
                {fragment.age}
              </span>
            )}
            {dropped && (
              <span className="text-micro font-semibold text-ink-faint">
                por debajo del mínimo — Cortex no lo puede citar
              </span>
            )}
            {!dropped && <CopyFragment fragment={fragment} />}
          </div>
        </div>

        <div className="w-[150px] shrink-0 pt-0.5">
          <ScoreRail
            cosine={fragment.cosine}
            keyword={fragment.keyword}
            verdict={fragment.verdict}
            rank={rank}
            generation={generation}
            cuts={cuts}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Copy the passage — and, as a side effect, tell the learning loop it was worth
 * copying.
 *
 * THE SIGNAL IS THE POINT, AND SO IS THE FACT THAT NOBODY IS BEING ASKED FOR
 * IT. A thumbs-up button collects the opinions of the two people who enjoy
 * pressing thumbs-up buttons. Copying a fragment is somebody taking it away to
 * use in a quote, an email or a call — an unambiguous positive that costs the
 * person nothing extra and that no amount of reading the logs could infer. It
 * feeds `learning_signals` (migration 0083), where it can only ever contribute
 * to a fragment being quoted EARLIER among fragments that already cleared the
 * relevance floor.
 *
 * The write is deliberately not awaited before the clipboard: the person asked
 * for text on their clipboard, not for a round trip. `recordSignal` swallows
 * its own failures for the same reason.
 */
function CopyFragment({ fragment }: { fragment: ProbeFragment }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(fragment.content).then(
          () => setCopied(true),
          () => undefined,
        );
        void noteFragmentCopied(fragment.documentId, fragment.chunkIndex);
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
      className="inline-flex items-center gap-1 text-micro font-semibold text-ink-faint transition-colors hover:text-primary"
      title="Copiar el fragmento. Cortex apunta que este te sirvió."
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'copiado' : 'copiar'}
    </button>
  );
}
