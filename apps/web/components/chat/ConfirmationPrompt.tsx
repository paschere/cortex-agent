'use client';

import { confirmationFollowUp, confirmationReason } from '@/lib/confirmation-notes';
import { confirmationSummary } from '@/lib/tool-labels';
import { clsx } from 'clsx';
import { Check, ChevronDown, Loader2, ShieldAlert, X } from 'lucide-react';
import { useState } from 'react';
import { resolveView } from './results/registry';

interface ConfirmationPromptProps {
  conversationId: string;
  toolId: string;
  input: unknown;
  toolCallId?: string;
  onConfirmed?: () => void;
  /** El canal de ChoicePrompt, para una tarjeta que habla por la persona. */
  onSay?: (text: string) => void;
}

type Status = 'pending' | 'running' | 'allowed' | 'cancelled' | 'error';

export function ConfirmationPrompt({
  conversationId,
  toolId,
  input,
  toolCallId,
  onConfirmed,
  onSay,
}: ConfirmationPromptProps) {
  const [status, setStatus] = useState<Status>('pending');
  const [errorMessage, setErrorMessage] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [executed, setExecuted] = useState<unknown>(undefined);

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
      // El resultado real de la ejecución, guardado para dibujarlo aquí mismo.
      // La ruta lo persiste sobre el centinela, pero eso vive en la BASE: el
      // mensaje que esta pantalla tiene en memoria sigue cargando el centinela,
      // y sin esto la primera vez que alguien vería la tarjeta de lo que acaba
      // de aprobar sería tras recargar la página. Se vio en producción con la
      // pestaña viva del navegador: la persona aprobaba, la pestaña se abría
      // de verdad, y el chat no enseñaba nada — así que la persona volvía a
      // pedir, y cada reintento abría otra pestaña hasta llenar el cupo.
      const data = (await res.json().catch(() => ({}))) as { result?: unknown };
      setExecuted(data.result);
      setStatus('allowed');
      // La continuación. `onSay` mete la aprobación como mensaje de la persona
      // con el desenlace en palabras — que es el ÚNICO canal por el que el
      // resultado alcanza al modelo, porque el historial entre turnos es texto
      // (ver confirmationFollowUp). `onConfirmed` (regenerar) queda solo de
      // respaldo para superficies sin compositor: regenerar borra el turno y
      // el modelo, sin el resultado a la vista, vuelve a pedir confirmación.
      if (onSay) onSay(confirmationFollowUp(toolId, data.result));
      else onConfirmed?.();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'No se pudo enviar la solicitud.');
      setStatus('error');
    }
  }

  const summary = confirmationSummary(
    toolId,
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {},
  );

  // ---- Resolved states ----
  if (status === 'allowed') {
    // Si lo ejecutado tiene vista propia (la pestaña viva del navegador, un
    // trámite que quedó esperando un captcha), se dibuja AQUÍ, debajo del
    // «Listo»: es la salida de lo que la persona acaba de aprobar y el sitio
    // donde la está mirando. En una recarga este prompt ya no existe — el
    // centinela fue reescrito — y la misma tarjeta sale por el camino normal
    // del registro, así que nunca hay dos.
    const resolved = executed === undefined ? null : resolveView(toolId, executed);
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 rounded-card border border-emerald/20 bg-emerald-soft px-3.5 py-2 text-sm font-medium text-emerald shadow-card">
          <Check className="h-4 w-4" />
          Listo — {summary}
        </div>
        {resolved?.as === 'rich' ? (
          <resolved.View
            result={executed}
            toolCallId={toolCallId ?? `confirmed:${toolId}`}
            onSay={onSay}
          />
        ) : null}
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
