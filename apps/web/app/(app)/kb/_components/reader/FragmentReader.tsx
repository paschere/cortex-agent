'use client';

import { Provenance } from '@/components/ui/provenance';
import { clsx } from 'clsx';
import { ArrowLeft, Loader2, Scissors, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { readFragments } from '../../actions';
import { ago, num, plural } from '../format';
import { usePrefersReducedMotion } from '../motion';
import { TINY_FRAGMENT_TOKENS } from '../types';
import type { Fragment, FragmentPage } from '../types';
import { FragmentSpine } from './FragmentSpine';

/**
 * A document, opened at the level Cortex actually works at.
 *
 * THE WHOLE POINT. The list of documents shows what somebody handed over. This
 * shows what was understood: the real fragments the text was broken into, the
 * exact words in each one, where each came from, and — the part nobody has ever
 * been able to see — WHERE THE CUTS FELL. A fragment read on its own is easy to
 * misjudge; the seam between two of them is how a person tells a good chunking
 * from one that will quietly ruin every search over this document.
 *
 * VOLUME. A serious space holds tens of thousands of fragments and one long
 * transcript can hold a couple of thousand. So nothing here loads a document
 * whole: thirty fragments come over the wire at a time, and the ribbon that
 * lets somebody jump anywhere in the document is a few hundred buckets of three
 * integers, computed on the server. Reading the fortieth thousand fragment
 * costs exactly what reading the first one costs.
 */

/** How much of a boundary to search for repeated text. */
const OVERLAP_LIMIT = 320;
/** Below this an apparent overlap is a coincidence — a shared closing phrase. */
const OVERLAP_MIN = 24;

/**
 * The text two consecutive fragments share.
 *
 * The chunkers repeat the tail of one fragment at the head of the next on
 * purpose — a conversation refers backwards constantly, and splitting "and when
 * would that be?" from "the 15th" leaves one fragment with a question nobody
 * answers and another with a date about nothing. That overlap is invisible in
 * every other view of this data and it explains a great deal: why the corpus
 * has more fragments than it looks like it should, and why two results
 * sometimes say the same thing.
 */
function overlapBetween(before: string, after: string): string {
  const max = Math.min(OVERLAP_LIMIT, before.length, after.length);
  for (let len = max; len >= OVERLAP_MIN; len -= 1) {
    if (before.endsWith(after.slice(0, len))) return after.slice(0, len);
  }
  return '';
}

/** `12:04` from milliseconds, the way a citation writes it. */
function offset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function FragmentReader({
  documentId,
  /** Land on this fragment — arrived here from the bench or from the analysis. */
  focusIndex,
  onBack,
  backLabel,
}: {
  documentId: string;
  focusIndex?: number | null;
  onBack: () => void;
  backLabel: string;
}) {
  const reduced = usePrefersReducedMotion();
  const [page, setPage] = useState<FragmentPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);

  const load = useCallback(
    async (from: number) => {
      ticket.current += 1;
      const mine = ticket.current;
      setLoading(true);
      setError(null);
      const res = await readFragments(documentId, from);
      if (ticket.current !== mine) return;
      setLoading(false);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPage(res.page);
    },
    [documentId],
  );

  // Open where the person was sent, not at the top. Arriving at fragment one of
  // a two-thousand-fragment transcript when the interesting one is number 814
  // is the difference between an instrument and a filing cabinet. Backed up a
  // little so the fragment lands with its neighbours around it.
  useEffect(() => {
    const start = focusIndex != null && focusIndex > 2 ? focusIndex - 2 : 0;
    void load(start);
  }, [load, focusIndex]);

  const marked = useRef<number | null>(null);
  const register = useCallback(
    (index: number, el: HTMLLIElement | null) => {
      if (!el || focusIndex == null || index !== focusIndex || marked.current === index) return;
      marked.current = index;
      el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    },
    [focusIndex, reduced],
  );

  const overlaps = useMemo(() => {
    const out = new Map<number, string>();
    const list = page?.fragments ?? [];
    for (let i = 0; i < list.length - 1; i += 1) {
      const a = list[i];
      const b = list[i + 1];
      if (!a || !b || b.chunkIndex !== a.chunkIndex + 1) continue;
      const shared = overlapBetween(a.content, b.content);
      if (shared) out.set(a.chunkIndex, shared);
    }
    return out;
  }, [page]);

  const total = page?.total ?? 0;
  const from = page?.from ?? 0;
  const shown = page?.fragments.length ?? 0;

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-semibold text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {backLabel}
        </button>
        {total > 0 && (
          <span className="tabular text-micro text-ink-faint">
            {num(from + 1)}–{num(from + shown)} de {num(total)}
          </span>
        )}
      </div>

      <div className="px-5 pt-2">
        <h2 className="truncate text-base font-extrabold tracking-tight text-ink">
          {page?.documentTitle ?? '…'}
        </h2>
        <p className="mt-0.5 text-xs text-ink-muted">
          {page ? (
            <>
              {plural(total, 'fragmento', 'fragmentos')} en {page.spaceName}. Esto — no el archivo —
              es lo que Cortex recupera para responder.
            </>
          ) : (
            'Leyendo…'
          )}
        </p>
      </div>

      {page && total > 0 && (
        <div className="px-5 pt-3">
          <FragmentSpine
            spine={page.spine}
            total={total}
            windowFrom={from}
            windowTo={from + shown - 1}
            focusIndex={focusIndex ?? null}
            sampled={page.spineSampled}
            onJump={(index) => {
              marked.current = null;
              void load(Math.max(0, index));
            }}
          />
        </div>
      )}

      {error && (
        <p className="mx-5 mt-3 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose">
          {error}
        </p>
      )}

      {loading && !page && (
        <p className="flex items-center gap-1.5 px-5 py-6 text-xs text-ink-faint">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          Leyendo los fragmentos…
        </p>
      )}

      {page && total === 0 && (
        <p className="max-w-xl px-5 py-6 text-xs leading-relaxed text-ink-muted">
          Este documento todavía no tiene fragmentos. O está en cola, o no se pudo leer — mientras
          tanto Cortex no puede citar nada de él.
        </p>
      )}

      {page && total > 0 && (
        <div
          className={clsx('min-h-0 flex-1 overflow-y-auto scroll-slim', loading && 'opacity-60')}
        >
          <ol className="px-5 pb-2 pt-4">
            {page.fragments.map((fragment, i) => (
              <li key={fragment.chunkId} ref={(el) => register(fragment.chunkIndex, el)}>
                <Piece fragment={fragment} focused={focusIndex === fragment.chunkIndex} />
                {i < page.fragments.length - 1 && (
                  <Seam
                    overlap={overlaps.get(fragment.chunkIndex) ?? ''}
                    cutOff={fragment.cutOff}
                    contiguous={page.fragments[i + 1]?.chunkIndex === fragment.chunkIndex + 1}
                  />
                )}
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
            <button
              type="button"
              disabled={from === 0 || loading}
              onClick={() => {
                marked.current = null;
                void load(Math.max(0, from - 30));
              }}
              className="rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-40"
            >
              Anteriores
            </button>
            <JumpBox
              total={total}
              onJump={(index) => {
                marked.current = null;
                void load(index);
              }}
            />
            <button
              type="button"
              disabled={from + shown >= total || loading}
              onClick={() => {
                marked.current = null;
                void load(from + shown);
              }}
              className="rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-40"
            >
              Siguientes
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** One fragment: what it says, where it came from, and whether it earns its keep. */
function Piece({ fragment, focused }: { fragment: Fragment; focused: boolean }) {
  const used = fragment.retrievalCount > 0;
  return (
    <article
      className={clsx(
        'rounded-card px-3.5 py-3 transition-colors duration-500',
        focused ? 'bg-primary-soft ring-1 ring-primary/30' : 'hover:bg-surface-2',
      )}
    >
      <div className="flex items-start gap-3">
        <span className="stat-num w-9 shrink-0 pt-0.5 text-right text-micro text-ink-faint">
          {num(fragment.chunkIndex + 1)}
        </span>
        <div className="min-w-0 flex-1">
          {/* Where it came from, before what it says: a sentence attributed to
              Ana at minute fourteen is read differently from the same sentence
              on page nine of a PDF, and the reader should know which it is
              before reading a word. */}
          {(fragment.speaker || fragment.startMs !== null) && (
            <div className="mb-1.5">
              <Provenance
                source={fragment.speaker ?? 'Grabación'}
                readAt={fragment.startMs !== null ? offset(fragment.startMs) : undefined}
                detail={
                  fragment.startMs !== null &&
                  fragment.endMs !== null &&
                  fragment.endMs > fragment.startMs
                    ? `hasta ${offset(fragment.endMs)}`
                    : undefined
                }
              />
            </div>
          )}

          <p className="whitespace-pre-wrap text-sm leading-[1.75] text-ink">
            {fragment.content}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-faint">
            <span className="tabular">{num(fragment.tokens)} tokens</span>
            {fragment.pages !== null && <span>de un PDF de {num(fragment.pages)} páginas</span>}
            <span
              className={clsx(
                'inline-flex items-center gap-1',
                used ? 'text-emerald' : 'text-ink-faint',
              )}
            >
              {used ? (
                <>
                  <Sparkles className="h-3 w-3" />
                  usado {plural(fragment.retrievalCount, 'vez', 'veces')}
                  {fragment.lastRetrievedAt && ` · ${ago(fragment.lastRetrievedAt)}`}
                </>
              ) : (
                'no se ha usado nunca'
              )}
            </span>
            {fragment.tokens < TINY_FRAGMENT_TOKENS && (
              <span className="text-amber">demasiado corto para significar algo</span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/**
 * The seam between two fragments — the thing this whole screen exists to show.
 *
 * Three different things can be true at a boundary and they mean different
 * things to somebody judging the memory: the two fragments repeat some text on
 * purpose (good, and worth seeing so the repetition in search results makes
 * sense), the first one stopped mid-sentence (bad, and the usual cause of a
 * retrieved passage that reads like nonsense), or neither (a clean break at a
 * paragraph, which is what it should look like).
 */
function Seam({
  overlap,
  cutOff,
  contiguous,
}: {
  overlap: string;
  cutOff: boolean;
  contiguous: boolean;
}) {
  if (!contiguous) return <div className="my-2 h-px bg-border" />;

  return (
    <div className="my-1 flex items-center gap-2 pl-12 pr-2">
      <span className={clsx('h-px flex-1', cutOff ? 'bg-amber/50' : 'bg-border')} aria-hidden />
      {cutOff ? (
        <span className="inline-flex items-center gap-1 whitespace-nowrap text-micro font-semibold text-amber">
          <Scissors className="h-3 w-3" />
          se cortó a mitad de una frase
        </span>
      ) : overlap ? (
        <span
          className="max-w-[60%] truncate whitespace-nowrap text-micro text-ink-faint"
          title={overlap}
        >
          se repite en los dos: «{overlap.trim()}»
        </span>
      ) : (
        <span className="whitespace-nowrap text-micro text-ink-faint">corte limpio</span>
      )}
      <span className={clsx('h-px flex-1', cutOff ? 'bg-amber/50' : 'bg-border')} aria-hidden />
    </div>
  );
}

/** Go straight to a fragment by its number, for anybody who already knows it. */
function JumpBox({ total, onJump }: { total: number; onJump: (index: number) => void }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number.parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1) return;
        onJump(Math.min(total - 1, n - 1));
      }}
    >
      <label htmlFor="kb-jump" className="text-micro text-ink-faint">
        Ir al
      </label>
      <input
        id="kb-jump"
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
        inputMode="numeric"
        placeholder="nº"
        className="tabular h-7 w-16 rounded-pill border border-border bg-surface px-2.5 text-micro text-ink focus:border-primary/40"
      />
    </form>
  );
}
