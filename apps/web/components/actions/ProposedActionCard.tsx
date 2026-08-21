'use client';

import { Provenance } from '@/components/ui/provenance';
import {
  type ActionView,
  KIND_AUDIENCE,
  OUTCOME_LABEL,
  OUTCOME_TONE,
  expiryPhrase,
  insistLine,
  shortHash,
} from '@/lib/actions-shape';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  Check,
  Clock,
  Lightbulb,
  Loader2,
  Mail,
  Pencil,
  Send,
  X,
} from 'lucide-react';
import { useState } from 'react';

/**
 * The card that turns an answer into something you can say yes to.
 *
 * It renders in two places — inside the chat thread, the moment Cortex proposes
 * something, and in the /actions queue afterwards — and it is one component on
 * purpose. Two renderings of the same draft is exactly how the text on screen
 * and the text that gets sent start to differ, which is the one thing this
 * feature may never do.
 *
 * ── WHAT IT SHOWS, AND WHY IT SHOWS ALL OF IT ─────────────────────────────
 * The whole body, not a summary. A card that says "cobro a Coltrans por
 * $12.400.000" and hides the paragraph underneath is asking for approval of a
 * headline, and the headline is not what gets sent. Everything the recipient
 * will read is on screen before the button is.
 *
 * ── THE SELLO ─────────────────────────────────────────────────────────────
 * The provenance chip carries the first twelve characters of the fingerprint of
 * the payload. Nobody compares those by eye, and that is not its job: it is
 * there so the thing being agreed to is a VISIBLE, specific object that changes
 * when the text changes. The same fingerprint travels with the Approve request
 * and sits in the WHERE clause of the statement that approves it — so if the
 * draft moved between this render and that click, the approval is refused and
 * says so, instead of quietly sending something else.
 *
 * ── COLOUR ────────────────────────────────────────────────────────────────
 * Indigo, not amber. Amber in this product means "a person has to look at
 * this" and is what the confirmation prompt wears when the model trips a gate.
 * This is not that: it is Cortex offering something it wrote. The one amber
 * note is the line warning that the recipient is outside the company, which is
 * the only fact here that can hurt.
 */

type Status =
  | 'idle'
  | 'editing'
  | 'saving'
  | 'sending'
  | 'sent'
  | 'dismissing'
  | 'dismissed'
  | 'error';

/**
 * The outcome palette speaks the design system's colour vocabulary, where the
 * absence of a claim is `ink`; the status chip calls that same absence
 * `neutral`. One translation here rather than a second palette that would
 * eventually disagree with the first.
 */
function outcomeChipTone(tone: 'emerald' | 'amber' | 'rose' | 'ink'): StatusTone {
  return tone === 'ink' ? 'neutral' : tone;
}

export interface ProposedActionCardProps {
  action: ActionView;
  /** Called after a successful send or dismissal, so a list can refresh. */
  onSettled?: () => void;
  /** Compact spacing for the chat transcript. */
  dense?: boolean;
}

export function ProposedActionCard({ action, onSettled, dense }: ProposedActionCardProps) {
  // The draft lives in state from here, because editing rewrites it and the
  // fingerprint moves with it. `hash` is always the fingerprint of what is
  // currently rendered — never the one this component was mounted with.
  const [draft, setDraft] = useState(action);
  const [hash, setHash] = useState(action.contentHash);
  const [status, setStatus] = useState<Status>('idle');
  const [message, setMessage] = useState('');
  const [subject, setSubject] = useState(action.subject);
  const [body, setBody] = useState(action.body);

  const external = KIND_AUDIENCE[draft.kind] === 'client';
  const busy = status === 'sending' || status === 'dismissing' || status === 'saving';

  async function send() {
    setStatus('sending');
    setMessage('');
    try {
      const res = await fetch(`/api/actions/${draft.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The id and the fingerprint. Never the text — the text is already on
        // the server and is what will be read by the statement that approves it.
        body: JSON.stringify({ action: 'approve', contentHash: hash }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage(data.error ?? 'No se pudo enviar.');
        setStatus('error');
        return;
      }
      setStatus('sent');
      onSettled?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'No se pudo enviar.');
      setStatus('error');
    }
  }

  async function dismiss() {
    setStatus('dismissing');
    try {
      const res = await fetch(`/api/actions/${draft.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dismiss' }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setMessage(data.error ?? 'No se pudo descartar.');
        setStatus('error');
        return;
      }
      setStatus('dismissed');
      onSettled?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'No se pudo descartar.');
      setStatus('error');
    }
  }

  async function saveEdit() {
    setStatus('saving');
    try {
      const res = await fetch(`/api/actions/${draft.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentHash: hash, subject, body }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        action?: ActionView;
      };
      if (!res.ok || !data.action) {
        setMessage(data.error ?? 'No se pudo guardar el cambio.');
        setStatus('error');
        return;
      }
      // The new fingerprint comes back with the saved text, so the next
      // Approve is against what is now on screen rather than what was.
      setDraft(data.action);
      setHash(data.action.contentHash);
      setSubject(data.action.subject);
      setBody(data.action.body);
      setStatus('idle');
      setMessage('');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'No se pudo guardar el cambio.');
      setStatus('error');
    }
  }

  // ---- Settled states ----------------------------------------------------
  if (status === 'sent') {
    return (
      <div className="rounded-card border border-emerald/25 bg-emerald-soft px-4 py-3 text-sm font-semibold text-emerald shadow-card">
        <div className="flex flex-wrap items-center gap-2">
          <Check className="h-4 w-4 shrink-0" />
          Enviada — {draft.kindLabel} a {draft.to.join(', ')}
        </div>
        <p className="mt-1 text-xs font-medium text-emerald">{insistLine()}</p>
      </div>
    );
  }
  if (status === 'dismissed') {
    return (
      <div className="flex items-center gap-2 rounded-card border border-border bg-surface-2 px-4 py-3 text-sm text-ink-muted">
        <X className="h-4 w-4 shrink-0" />
        Descartada — no se envió nada
      </div>
    );
  }

  // An action that arrives already decided (the queue shows recent history)
  // states what happened instead of offering a second, conflicting decision.
  if (draft.state !== 'proposed') {
    return <SettledSummary action={draft} />;
  }

  const editing = status === 'editing' || status === 'saving';

  return (
    <div
      className={clsx(
        'overflow-hidden rounded-card border border-primary/25 bg-surface shadow-card',
        dense ? 'mt-2' : '',
      )}
    >
      {/* Header — what this is, and how long it stays offerable. */}
      <div className="flex flex-wrap items-start gap-3 bg-primary-soft px-4 py-3.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-primary/15 text-primary">
          <Send className="h-[17px] w-[17px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-micro font-semibold text-primary-ink">
              Acción propuesta · {draft.kindLabel}
            </span>
            <span className="tabular inline-flex items-center gap-1 rounded-pill border border-border bg-surface px-2 py-0.5 text-micro font-semibold text-ink-muted">
              <Clock className="h-3 w-3" />
              {expiryPhrase(draft.expiresAt)}
            </span>
          </div>
          {/* Where it came from. An action with no derivation is a suggestion,
              and this product does not make suggestions. */}
          <p className="mt-1 flex items-start gap-1.5 text-xs leading-snug text-ink-muted">
            <Lightbulb className="mt-[3px] h-3.5 w-3.5 shrink-0 text-primary" />
            {draft.rationale}
          </p>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3.5">
        {/* Recipient — monospaced, because it is the value most worth checking
            before anything leaves. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="field-label">Para</span>
          <span className="tabular text-xs font-medium text-ink">{draft.to.join(', ')}</span>
          {draft.cc.length > 0 && (
            <>
              <span className="field-label">Copia</span>
              <span className="tabular text-xs text-ink-muted">{draft.cc.join(', ')}</span>
            </>
          )}
        </div>

        {external && (
          <p className="flex items-start gap-1.5 rounded-sm border border-amber/25 bg-amber-soft px-2.5 py-1.5 text-xs leading-snug text-amber">
            <AlertTriangle className="mt-[2px] h-3.5 w-3.5 shrink-0" />
            Sale de tu Gmail hacia una persona fuera de la empresa y no se puede recuperar.
          </p>
        )}

        {editing ? (
          <div className="space-y-2">
            <label className="block">
              <span className="field-label">Asunto</span>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="mt-1 w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-sm font-semibold text-ink"
              />
            </label>
            <label className="block">
              <span className="field-label">Mensaje</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={12}
                className="scroll-slim mt-1 w-full rounded-sm border border-border bg-surface px-2.5 py-2 text-sm leading-relaxed text-ink"
              />
            </label>
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="text-sm font-semibold text-ink">{draft.subject}</p>
            {/* The entire message. Nothing collapsed, nothing summarised. */}
            <p className="scroll-slim max-h-80 overflow-auto whitespace-pre-wrap rounded-sm border border-border bg-surface-2 px-3 py-2.5 text-sm leading-relaxed text-ink-muted">
              {draft.body}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Provenance source="Sello" detail={shortHash(hash)} />
          {draft.editedCount > 0 && (
            <span className={chipClass('neutral')}>
              <Pencil className="h-3 w-3" />
              Editada {draft.editedCount === 1 ? 'una vez' : `${draft.editedCount} veces`}
            </span>
          )}
        </div>

        {status === 'error' && message && (
          <p className="rounded-sm border border-rose/25 bg-rose-soft px-2.5 py-1.5 text-xs leading-snug text-rose">
            {message}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          {editing ? (
            <>
              <button
                type="button"
                onClick={saveEdit}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-white shadow-card transition-all duration-150 hover:-translate-y-px hover:brightness-95 disabled:opacity-60 motion-reduce:transform-none motion-reduce:transition-none"
              >
                {status === 'saving' ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{' '}
                    Guardando…
                  </>
                ) : (
                  <>
                    <Check className="h-3.5 w-3.5" /> Guardar el cambio
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setSubject(draft.subject);
                  setBody(draft.body);
                  setStatus('idle');
                }}
                disabled={busy}
                className="rounded-pill px-3 py-2 text-sm font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-60"
              >
                Cancelar
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={send}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-sm font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:brightness-95 disabled:opacity-60 disabled:shadow-none motion-reduce:transform-none motion-reduce:transition-none"
              >
                {status === 'sending' ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{' '}
                    Enviando…
                  </>
                ) : (
                  <>
                    <Mail className="h-3.5 w-3.5" />{' '}
                    {status === 'error' ? 'Reintentar el envío' : 'Aprobar y enviar'}
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => setStatus('editing')}
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-2 text-sm font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-60"
              >
                <Pencil className="h-3.5 w-3.5" /> Editar
              </button>
              <button
                type="button"
                onClick={dismiss}
                disabled={busy}
                className="rounded-pill px-3 py-2 text-sm font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-60"
              >
                {status === 'dismissing' ? 'Descartando…' : 'Descartar'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * An action that has already been decided. It states what happened and what
 * came of it — a decided action that still shows a button is an invitation to
 * press it and wonder why nothing happens.
 */
function SettledSummary({ action }: { action: ActionView }) {
  const sent = action.state === 'approved' && action.executedAt;
  return (
    <div
      className={clsx(
        'rounded-card border px-4 py-3 shadow-card',
        sent ? 'border-emerald/25 bg-surface' : 'border-border bg-surface-2',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {sent ? (
          <Check className="h-4 w-4 shrink-0 text-emerald" />
        ) : (
          <X className="h-4 w-4 shrink-0 text-ink-faint" />
        )}
        <span className="text-sm font-semibold text-ink">
          {sent ? 'Enviada' : action.stateLabel} — {action.kindLabel}
        </span>
        <span className="tabular text-xs text-ink-muted">{action.to.join(', ')}</span>
        {sent && (
          <span className={chipClass(outcomeChipTone(OUTCOME_TONE[action.outcome]))}>
            {OUTCOME_LABEL[action.outcome]}
          </span>
        )}
      </div>
      <p className="mt-1 truncate text-xs text-ink-muted">{action.subject}</p>
      {action.outcomeNote && <p className="mt-1 text-xs text-ink-faint">{action.outcomeNote}</p>}
    </div>
  );
}
