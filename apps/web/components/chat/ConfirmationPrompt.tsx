'use client';

import { confirmationReason } from '@/lib/confirmation-notes';
import { confirmationSummary } from '@/lib/tool-labels';
import { clsx } from 'clsx';
import { Check, ChevronDown, Loader2, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';

interface ConfirmationPromptProps {
  conversationId: string;
  toolId: string;
  input: unknown;
  toolCallId?: string;
  onConfirmed?: () => void;
}

type Status = 'pending' | 'running' | 'allowed' | 'cancelled' | 'error';

export function ConfirmationPrompt({
  conversationId,
  toolId,
  input,
  toolCallId,
  onConfirmed,
}: ConfirmationPromptProps) {
  const [status, setStatus] = useState<Status>('pending');
  const [errorMessage, setErrorMessage] = useState('');
  const [showDetails, setShowDetails] = useState(false);

  async function handleAllow() {
    setStatus('running');
    try {
      const res = await fetch('/api/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, toolId, input, toolCallId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage((data as { error?: string }).error ?? 'Error desconocido.');
        setStatus('error');
        return;
      }
      setStatus('allowed');
      onConfirmed?.();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'No se pudo enviar la solicitud.');
      setStatus('error');
    }
  }

  const summary = confirmationSummary(
    toolId,
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
  );

  // ---- Resolved states (one ruled line) ----
  if (status === 'allowed') {
    return (
      <div className="flex items-center gap-2 rounded-card border border-emerald/40 bg-emerald-soft px-3 py-2 text-[13px] font-medium text-emerald">
        <Check className="h-4 w-4" />
        Listo — {summary}
      </div>
    );
  }
  if (status === 'cancelled') {
    return (
      <div className="flex items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2 text-[13px] text-ink-faint">
        <X className="h-4 w-4" />
        Descartada
      </div>
    );
  }

  // ---- Pending / running / error card ----
  // Amber, never red: this is an action waiting on a decision, not one that
  // was refused, and red is the stamp that stops a document.
  return (
    <div className="overflow-hidden rounded-card border border-amber/40 bg-surface">
      <div className="flex items-start gap-3 border-b border-amber/30 bg-amber-soft px-4 py-3">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-card bg-amber/15 text-amber">
          <ShieldAlert className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          {/* Stamped across the top of the block, the way a form is marked as
              held. Not `.field-label` — that class names a box, this names a
              state. */}
          <div className="font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-amber">
            Confirmación requerida
          </div>
          <p className="mt-1 text-sm font-semibold text-ink">{summary}</p>
          <p className="mt-1 text-[12px] leading-snug text-ink-muted">
            {confirmationReason(toolId)}
          </p>
        </div>
      </div>

      <div className="px-4 py-3">
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
          className="flex items-center gap-1 text-xs font-medium text-ink-faint hover:text-ink-muted"
        >
          <ChevronDown
            className={clsx('h-3.5 w-3.5 transition-transform', showDetails && 'rotate-180')}
          />
          {showDetails ? 'Ocultar' : 'Ver'} lo que se va a enviar
        </button>
        {showDetails && (
          // Exactly what leaves the building, in the face evidence is set in.
          <pre className="scroll-slim mt-2 max-h-48 overflow-auto rounded-card border border-border bg-surface-2 p-2 font-mono text-[10.5px] leading-relaxed text-ink-muted">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}

        {status === 'error' && (
          <p className="mt-2 rounded-card border border-rose/40 bg-rose-soft px-2.5 py-1.5 text-xs text-rose">
            {errorMessage}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleAllow}
            disabled={status === 'running'}
            className="inline-flex items-center gap-1.5 rounded-card bg-amber px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:brightness-95 disabled:opacity-60"
          >
            {status === 'running' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Ejecutando…
              </>
            ) : (
              <>
                <Check className="h-3.5 w-3.5" />{' '}
                {status === 'error' ? 'Reintentar' : 'Confirmar y ejecutar'}
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => setStatus('cancelled')}
            disabled={status === 'running'}
            className="rounded-card px-3 py-2 text-[13px] font-medium text-ink-muted transition-colors hover:bg-surface-2 disabled:opacity-60"
          >
            Descartar
          </button>
        </div>
      </div>
    </div>
  );
}
