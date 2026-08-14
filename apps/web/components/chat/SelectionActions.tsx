'use client';

import { recordCommitment } from '@/app/(app)/commitments/actions';
import { COMMITMENT_KINDS, KIND_LABEL } from '@/lib/commitments-shape';
import type { CommitmentKind } from '@/lib/commitments-shape';
import { clsx } from 'clsx';
import { CalendarPlus, Check, Copy, Loader2, MessageCircleQuestion } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/**
 * SELECT PART OF AN ANSWER AND DO SOMETHING WITH IT.
 *
 * ===========================================================================
 * WHY THESE THREE AND NOT THE USUAL FIVE
 * ===========================================================================
 * The reference offers Explain / Improve / Shorten / Tone / Grammar. Those are
 * the actions of a WRITING tool, where the text on screen is the artifact and
 * the user is its author. Here it is the opposite: the text is Cortex's answer
 * about the company's data, the person did not write it and does not want to
 * restyle it, and "improve this paragraph" is a meaningless request to make of
 * a figure that came out of a database.
 *
 * What somebody actually does with a sentence in an answer here is act on it,
 * file it, or push on it. So:
 *
 *   COMPROMISO CON FECHA — the one that turns reading into work. Half of what
 *     this product says out loud is a dated obligation ("el SOAT de ABC123 se
 *     vence el 14 de septiembre"), and the gap between reading that and it
 *     being watched was a person remembering to go to another screen. It opens
 *     a form rather than creating silently: a commitment is a real record that
 *     will send notices, and it needs a date that only a human can confirm.
 *
 *   COPIAR CON LA FUENTE — the one this product exists for. A figure pasted
 *     into WhatsApp without its origin is exactly the artifact Cortex was built
 *     to stop being produced. So the plain copy button on the message copies
 *     the whole answer, and this one copies a fragment WITH the line that says
 *     where it came from. There is deliberately no "copy just the text": if
 *     somebody wants that they can select and press ⌘C, which is the operating
 *     system's job, not a button we put next to a number.
 *
 *   PREGUNTAR SOBRE ESTO — the cheapest and most used. Quotes the fragment into
 *     the composer so the next question is anchored to it and the model is not
 *     guessing which of six figures "ese" refers to.
 *
 * Nothing here mutates the answer. An answer is a record of what was said, and
 * a surface that let you edit it in place would make the transcript worthless
 * as evidence.
 *
 * ===========================================================================
 * KEYBOARD
 * ===========================================================================
 * The toolbar is positioned near the selection but lives in the DOM right after
 * the message body, so tabbing forward out of a message reaches it — a
 * selection made with shift+arrows gets the same three buttons as one made with
 * a mouse, in the order they are read. Escape dismisses it and returns nothing,
 * and the buttons are ordinary `<button>`s with visible focus from the global
 * `:focus-visible` rule.
 */

export interface SelectionProvenance {
  /** The conversation this was said in — the address of the evidence. */
  conversationId?: string;
  /** Already formatted; this component does not guess a locale. */
  saidAt: string;
}

type Mode = 'idle' | 'menu' | 'commitment';

/** Below this a "selection" is usually a stray double-click, not an intent. */
const MIN_CHARS = 12;
const MAX_QUOTE = 600;

function todayInBogota(): string {
  // The date input needs `YYYY-MM-DD` in the operator's own day, not UTC's.
  return new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }),
  )
    .toISOString()
    .slice(0, 10);
}

export function SelectionActions({
  containerRef,
  provenance,
  onAsk,
}: {
  containerRef: RefObject<HTMLElement | null>;
  provenance: SelectionProvenance;
  onAsk: (quote: string) => void;
}) {
  const [quote, setQuote] = useState('');
  const [mode, setMode] = useState<Mode>('idle');
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const read = useCallback(() => {
    // While the form is open the selection is irrelevant — the person has moved
    // on to typing a date, and collapsing the panel under them would be rude.
    if (mode === 'commitment') return;

    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (!selection || selection.rangeCount === 0 || text.length < MIN_CHARS) {
      setMode('idle');
      setQuote('');
      return;
    }
    const container = containerRef.current;
    const node = selection.anchorNode;
    if (!container || !node || !container.contains(node)) {
      setMode('idle');
      setQuote('');
      return;
    }
    setQuote(text.slice(0, MAX_QUOTE));
    setMode('menu');
  }, [containerRef, mode]);

  useEffect(() => {
    document.addEventListener('selectionchange', read);
    return () => document.removeEventListener('selectionchange', read);
  }, [read]);

  useEffect(() => {
    if (mode === 'idle') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMode('idle');
        setQuote('');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode]);

  if (mode === 'idle' || !quote) return null;

  /**
   * The quote and the line that makes it citable.
   *
   * `>` marks it as quoted rather than authored, and the attribution names the
   * conversation it came from — which is a real address: that id opens the
   * exchange, with the tool calls that produced the figure still attached.
   */
  const withSource = [
    quote
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
    '',
    provenance.conversationId
      ? `— Cortex · conversación #${provenance.conversationId.slice(0, 8)} · ${provenance.saidAt}`
      : `— Cortex · ${provenance.saidAt}`,
  ].join('\n');

  return (
    <div
      ref={rootRef}
      className="animate-rise mt-2 inline-flex max-w-full flex-col gap-2 rounded-card border border-border bg-surface p-1.5 shadow-pop"
    >
      {mode === 'menu' ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="px-2 text-micro font-semibold uppercase tracking-field text-ink-faint">
            Selección
          </span>
          <ChipButton icon={CalendarPlus} onClick={() => setMode('commitment')}>
            Convertir en compromiso
          </ChipButton>
          <ChipButton
            icon={copied ? Check : Copy}
            tone={copied ? 'done' : 'plain'}
            onClick={() => {
              void navigator.clipboard.writeText(withSource);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            {copied ? 'Copiado con la fuente' : 'Copiar con la fuente'}
          </ChipButton>
          <ChipButton
            icon={MessageCircleQuestion}
            onClick={() => {
              onAsk(quote);
              setMode('idle');
              window.getSelection()?.removeAllRanges();
            }}
          >
            Preguntar sobre esto
          </ChipButton>
        </div>
      ) : (
        <CommitmentForm
          quote={quote}
          onCancel={() => setMode('menu')}
          onDone={() => {
            setMode('idle');
            setQuote('');
            window.getSelection()?.removeAllRanges();
          }}
        />
      )}
    </div>
  );
}

function ChipButton({
  icon: Icon,
  children,
  onClick,
  tone = 'plain',
}: {
  icon: typeof Copy;
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'plain' | 'done';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-xs font-medium transition-colors duration-150 motion-reduce:transition-none',
        tone === 'done'
          ? 'bg-emerald-soft text-emerald'
          : 'text-ink-muted hover:bg-primary-soft hover:text-primary-ink',
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      {children}
    </button>
  );
}

/**
 * A commitment, from a sentence.
 *
 * The date is required and empty by default. Guessing it from the text would be
 * the obvious flourish and it is the wrong call: this row will send notices and
 * escalate, and a date parsed out of prose is exactly the kind of plausible
 * mistake nobody checks. The person read the sentence; they can type the day.
 *
 * `recordCommitment` stamps the source as manual, which is the truth — a human
 * decided this is a commitment. The quoted answer travels in `detail`, so the
 * card on /commitments still says where the idea came from.
 */
function CommitmentForm({
  quote,
  onCancel,
  onDone,
}: {
  quote: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const firstField = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(quote.slice(0, 120).replace(/\s+/g, ' ').trim());
  const [dueOn, setDueOn] = useState('');
  const [kind, setKind] = useState<CommitmentKind>('other');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await recordCommitment({
      title,
      dueOn,
      kind,
      detail: `Salió de una respuesta de Cortex:\n\n"${quote}"`,
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'No se pudo registrar el compromiso.');
      return;
    }
    onDone();
  }

  return (
    <form onSubmit={submit} className="flex w-[min(30rem,80vw)] flex-col gap-2 p-1.5">
      <label className="field-label" htmlFor="sel-title">
        Compromiso
      </label>
      <input
        id="sel-title"
        ref={firstField}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={160}
        className="w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-primary/40"
      />

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[9rem] flex-1">
          <label className="field-label" htmlFor="sel-due">
            Se vence
          </label>
          <input
            id="sel-due"
            type="date"
            required
            min={todayInBogota()}
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
            className="tabular mt-1 w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-primary/40"
          />
        </div>
        <div className="min-w-[9rem] flex-1">
          <label className="field-label" htmlFor="sel-kind">
            Tipo
          </label>
          <select
            id="sel-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as CommitmentKind)}
            className="mt-1 w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-sm text-ink outline-none focus:border-primary/40"
          >
            {COMMITMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-xs text-rose">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-pill px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-2"
        >
          Volver
        </button>
        <button
          type="submit"
          disabled={busy || !title.trim() || !dueOn}
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3.5 py-1.5 text-xs font-semibold text-white shadow-pop transition-colors duration-150 hover:bg-primary-strong disabled:opacity-40 disabled:shadow-none motion-reduce:transition-none"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Registrar
        </button>
      </div>
    </form>
  );
}
