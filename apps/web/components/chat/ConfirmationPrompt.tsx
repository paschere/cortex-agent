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

  // ---- Resolved states (a single settled line) ----
  if (status === 'allowed') {
    return (
      <div className="flex items-center gap-2 rounded-card border border-emerald/20 bg-emerald-soft px-3.5 py-2 text-sm font-medium text-emerald shadow-card">
        <Check className="h-4 w-4" />
        Listo — {summary}
      </div>
    );
  }
  if (status === 'cancelled') {
    return (
      <div className="flex items-center gap-2 rounded-card border border-border bg-surface-2 px-3.5 py-2 text-sm text-ink-faint">
        <X className="h-4 w-4" />
        Descartada
      </div>
    );
  }

  // ---- Pending / running / error card ----
  // Amber, never red: this is an action waiting on a decision, not one that
  // was refused, and red is reserved for what cannot be undone.
  return (
    <div className="overflow-hidden rounded-card border border-amber/25 bg-surface shadow-card">
      <div className="flex items-start gap-3 bg-amber-soft px-4 py-3.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-amber/15 text-amber">
          <ShieldAlert className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          {/* Names the state of the whole block, not a value beneath it, so
              it is deliberately not `.field-label`. */}
          <div className="text-micro font-semibold text-amber">Confirmación requerida</div>
          <p className="mt-1 text-sm font-semibold text-ink">{summary}</p>
          <p className="mt-1 text-xs leading-snug text-ink-muted">{confirmationReason(toolId)}</p>
        </div>
      </div>

      <div className="px-4 py-3">
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          aria-expanded={showDetails}
          className="flex items-center gap-1 rounded-pill text-xs font-medium text-ink-faint transition-colors duration-150 hover:text-primary motion-reduce:transition-none"
        >
          <ChevronDown
            className={clsx(
              'h-3.5 w-3.5 transition-transform duration-150 motion-reduce:transition-none',
              showDetails && 'rotate-180',
            )}
          />
          {showDetails ? 'Ocultar' : 'Ver'} lo que se va a enviar
        </button>
        {showDetails && (
          // Exactly what leaves the building, in the face evidence is set in.
          <pre className="scroll-slim mt-2 max-h-48 overflow-auto rounded-sm border border-border bg-surface-2 p-2.5 font-mono text-micro leading-relaxed text-ink-muted">
            {JSON.stringify(input, null, 2)}
          </pre>
        )}

        {status === 'error' && (
          <p className="mt-2 rounded-sm border border-rose/20 bg-rose-soft px-2.5 py-1.5 text-xs text-rose">
            {errorMessage}
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={handleAllow}
            disabled={status === 'running'}
            className="inline-flex items-center gap-1.5 rounded-pill bg-amber px-4 py-2 text-sm font-semibold text-white shadow-card transition-all duration-150 hover:-translate-y-px hover:brightness-95 disabled:opacity-60 disabled:shadow-none motion-reduce:transform-none motion-reduce:transition-none"
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
            className="rounded-pill px-4 py-2 text-sm font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-60 motion-reduce:transition-none"
          >
            Descartar
          </button>
        </div>
      </div>
    </div>
  );
}
