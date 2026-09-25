'use client';

import {
  acceptMemoryProposalAction,
  rejectMemoryProposalAction,
} from '@/lib/memory-proposals/actions';
import { clsx } from 'clsx';
import { BookmarkPlus, Check, Loader2, X } from 'lucide-react';
import { useState, useTransition } from 'react';
import type { ResultViewProps } from './registry';

/**
 * UN RECUERDO PROPUESTO PARA LA EMPRESA, EN EL CHAT (migración 0157).
 *
 * Cortex escuchó un acuerdo, un precio o una decisión y propone guardarlo. La
 * tarjeta enseña la frase ya redactada y, debajo, las palabras literales de la
 * persona — lo que se guarda y de dónde salió, uno al lado del otro, para que
 * quien aprueba vea si Cortex entendió bien. Si quien mira puede aportar en el
 * espacio, aprueba aquí mismo; si no, queda esperando en Brain Knowledge.
 */

interface Proposal {
  proposed: boolean;
  proposalId: string | null;
  statement: string;
  quote: string;
  subject: string | null;
  space: string | null;
  canAccept: boolean;
  markdown: string;
}

function proposalOf(result: unknown): Proposal | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (typeof r.statement !== 'string' || typeof r.quote !== 'string') return null;
  return {
    proposed: r.proposed === true,
    proposalId: typeof r.proposalId === 'string' ? r.proposalId : null,
    statement: r.statement,
    quote: r.quote,
    subject: typeof r.subject === 'string' ? r.subject : null,
    space: typeof r.space === 'string' ? r.space : null,
    canAccept: r.canAccept === true,
    markdown: typeof r.markdown === 'string' ? r.markdown : '',
  };
}

export function MemoryProposalCard({ result }: ResultViewProps) {
  const p = proposalOf(result);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  if (!p) return null;

  const decide = (accept: boolean) =>
    start(async () => {
      if (!p.proposalId) return;
      const res = accept
        ? await acceptMemoryProposalAction(p.proposalId)
        : await rejectMemoryProposalAction(p.proposalId);
      setOutcome(res.ok ? { ok: true, text: res.message } : { ok: false, text: res.error });
    });

  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <BookmarkPlus className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="field-label">Recuerdo para la empresa</span>
        {p.subject && <span className="truncate text-micro text-ink-faint">· {p.subject}</span>}
      </div>
      <div className="space-y-2 px-4 py-3">
        <p className="text-sm font-medium leading-relaxed text-ink">{p.statement}</p>
        <p className="border-l-2 border-border-strong pl-3 text-xs italic leading-relaxed text-ink-muted">
          «{p.quote}»
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-surface-2/60 px-4 py-2.5">
        {outcome ? (
          <p className={clsx('text-xs', outcome.ok ? 'text-emerald' : 'text-rose')}>
            {outcome.text}
          </p>
        ) : !p.proposed ? (
          <p className="text-xs text-ink-muted">{p.markdown}</p>
        ) : p.canAccept ? (
          <>
            <p className="text-micro text-ink-faint">
              Se guardaría en «{p.space}». Todos los que ven ese espacio lo tendrán en cuenta.
            </p>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={pending}
                onClick={() => decide(false)}
                className="inline-flex items-center gap-1 rounded-pill px-2.5 py-1 text-xs font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-45"
              >
                <X className="h-3.5 w-3.5" /> Descartar
              </button>
              <button
                type="button"
                disabled={pending}
                onClick={() => decide(true)}
                className="cortex-primary-button inline-flex items-center gap-1 rounded-pill bg-primary px-3 py-1 text-xs font-semibold text-white hover:bg-primary-strong disabled:opacity-45"
              >
                {pending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Check className="h-3.5 w-3.5" />
                )}
                Guardar
              </button>
            </div>
          </>
        ) : (
          <p className="text-micro text-ink-faint">
            Queda esperando que alguien con permiso lo apruebe en Brain Knowledge.
          </p>
        )}
      </div>
    </div>
  );
}
