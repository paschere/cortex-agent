'use client';

import { dedupeProposals } from '@/lib/confirmation-dedupe';
import { confirmationFollowUp } from '@/lib/confirmation-notes';
import { mandatoryHumanConfirmation } from '@cortex/agent-tools/src/security/mandatory-confirmation';
import { Check, Loader2 } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  type CardHandle,
  ConfirmationPrompt,
  type ConfirmationPromptProps,
  type GroupOutcome,
} from './ConfirmationPrompt';

/**
 * VARIAS TARJETAS PENDIENTES EN EL MISMO MENSAJE.
 *
 * Una sola se dibuja como siempre. Con dos o más aparece la barra «Aprobar las
 * N»: aprueba una por una, en orden, por la MISMA ruta de cada tarjeta (el
 * reclamo CAS del servidor sigue siendo por tarjeta), y se detiene en la primera
 * que falla. Las acciones no delegables (`mandatoryHumanConfirmation`: pagos,
 * borrados, accesos…) NO entran en la barra: se aprueban a mano, una a una.
 *
 * El turno continúa UNA vez, cuando todas las tarjetas se resolvieron — no una
 * por tarjeta, que arrancaría varios turnos encima de las que siguen pendientes.
 */

export interface GroupItem {
  toolCallId: string;
  toolId: string;
  input: unknown;
}

type GroupProps = Pick<
  ConfirmationPromptProps,
  'conversationId' | 'onConfirmed' | 'onSay' | 'waiting' | 'why'
> & { items: GroupItem[] };

export function followUpFor(outcomes: GroupOutcome[]): string | null {
  const done = outcomes.filter((o) => o.status === 'allowed');
  const refused = outcomes.filter((o) => o.status === 'cancelled');
  const parts: string[] = [];
  if (done.length === 1 && done[0])
    parts.push(confirmationFollowUp(done[0].toolId, done[0].result));
  else if (done.length > 1)
    parts.push(
      `Aprobé y ya se ejecutaron ${done.length} acciones (${done.map((o) => o.summary).join('; ')}). Sigue con el siguiente paso de lo que te pedí, sin repetir lo que ya quedó hecho.`,
    );
  for (const o of refused)
    if (o.reason) parts.push(`No apruebes esto: ${o.summary}. Motivo: ${o.reason}`);
  return parts.length ? parts.join('\n') : null;
}

export function ConfirmationGroup({
  items: proposed,
  conversationId,
  onConfirmed,
  onSay,
  waiting,
  why,
}: GroupProps) {
  // Una propuesta idéntica es una tarjeta: nunca dos «dobles autenticaciones».
  const items = dedupeProposals(proposed);
  const handles = useRef(new Map<string, CardHandle>());
  const outcomes = useRef(new Map<string, GroupOutcome>());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [stoppedAt, setStoppedAt] = useState<string | null>(null);

  const finishIfAllResolved = () => {
    if (outcomes.current.size < items.length) return;
    const text = followUpFor([...outcomes.current.values()]);
    if (text && onSay) onSay(text);
    else if (text) onConfirmed?.();
  };

  const eligible = () =>
    items.filter(
      (i) => !mandatoryHumanConfirmation(i.toolId) && handles.current.get(i.toolCallId)?.ready(),
    );

  async function approveAll() {
    const queue = eligible();
    if (queue.length === 0) return;
    setRunning(true);
    setStoppedAt(null);
    setProgress({ done: 0, total: queue.length });
    let n = 0;
    for (const item of queue) {
      const ok = (await handles.current.get(item.toolCallId)?.approve()) ?? false;
      if (!ok) {
        setStoppedAt(item.toolId);
        break;
      }
      n += 1;
      setProgress({ done: n, total: queue.length });
    }
    setRunning(false);
  }

  if (items.length === 1 && items[0]) {
    const only = items[0];
    return (
      <ConfirmationPrompt
        conversationId={conversationId}
        toolId={only.toolId}
        input={only.input}
        toolCallId={only.toolCallId}
        onConfirmed={onConfirmed}
        onSay={onSay}
        waiting={waiting}
        why={why}
      />
    );
  }

  const count = items.filter((i) => !mandatoryHumanConfirmation(i.toolId)).length;
  const manual = items.length - count;
  return (
    <div className="space-y-2">
      {count >= 2 && (
        <fieldset
          aria-label="Aprobar varias acciones"
          className="flex flex-wrap items-center gap-2 rounded-card border border-amber/25 bg-amber-soft px-3.5 py-2.5"
        >
          <button
            type="button"
            onClick={() => void approveAll()}
            disabled={running || waiting}
            className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-sm font-semibold text-white shadow-card disabled:opacity-60"
          >
            {running ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Aprobando{' '}
                {progress ? `${progress.done + 1} de ${progress.total}` : ''}…
              </>
            ) : (
              <>
                <Check className="h-3.5 w-3.5" aria-hidden /> Aprobar las {count}
              </>
            )}
          </button>
          <span className="text-xs text-ink-muted">
            Una por una, en orden
            {manual > 0
              ? ` · ${manual === 1 ? 'otra pide' : `otras ${manual} piden`} aprobación a mano`
              : ''}
            .
          </span>
          {stoppedAt && (
            <span role="alert" className="w-full text-xs font-medium text-rose">
              Me detuve en una que falló. Las demás siguen pendientes.
            </span>
          )}
        </fieldset>
      )}
      {items.map((item) => (
        <ConfirmationPrompt
          key={item.toolCallId}
          conversationId={conversationId}
          toolId={item.toolId}
          input={item.input}
          toolCallId={item.toolCallId}
          onSay={onSay}
          waiting={waiting}
          why={why}
          handleRef={(h) => {
            if (h) handles.current.set(item.toolCallId, h);
            else handles.current.delete(item.toolCallId);
          }}
          group={{
            report: (o) => {
              outcomes.current.set(item.toolCallId, o);
              finishIfAllResolved();
            },
          }}
        />
      ))}
    </div>
  );
}
