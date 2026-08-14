'use client';

import { ProposedActionCard } from '@/components/actions/ProposedActionCard';
import type { ActionView } from '@/lib/actions-shape';
import { Inbox, Send } from 'lucide-react';
import type { ResultViewProps } from './registry';

/**
 * «¿QUÉ ESTÁ ESPERANDO POR MÍ?», CONTESTADO CON LOS BOTONES PUESTOS.
 *
 * ===========================================================================
 * POR QUÉ ESTA ES LA PRIMERA DE LAS CINCO
 * ===========================================================================
 * `actions.list` está en el menú `/` desde hace meses, con la frase «Muéstrame
 * las acciones que esperan mi aprobación». Alguien la escribía, recibía una fila
 * gris con un JSON detrás de un chevron, y se iba a `/actions` a hacer lo que
 * acababa de preguntar. No fue que no supiera dónde estaba la pantalla:
 * preguntó, y no le contestaron.
 *
 * ===========================================================================
 * LA TARJETA ES LA MISMA DE `/actions`. NO UNA VERSIÓN PARA EL CHAT
 * ===========================================================================
 * `ProposedActionCard` se monta en las dos superficies, y su cabecera explica
 * por qué eso no es negociable: dos dibujos del mismo borrador es exactamente
 * cómo el texto que está en pantalla y el que sale por correo empiezan a
 * diferir, que es la única cosa que esta función no puede hacer nunca. Lo único
 * que aporta el chat es `dense`.
 *
 * Por eso esta vista es casi todo comentario: la reutilización no dejó código
 * que escribir, y ese era el punto.
 *
 * ===========================================================================
 * TRES ABIERTAS, EL RESTO PLEGADO
 * ===========================================================================
 * Cada tarjeta enseña el correo ENTERO —el cuerpo completo, no un titular—
 * porque aprobar un titular no es aprobar lo que se envía. Veinte de esas
 * seguidas no son una cola: son una pared, que es justo lo que `TaskRows` existe
 * para evitar. Así que tres se ven, y las demás siguen ahí, contadas y a un
 * clic. Ninguna se pierde: lo que no se enseña se dice.
 */

const OPEN = 3;

export function ActionsQueue({ result, onSettled }: ResultViewProps) {
  const actions = actionsOf(result);
  if (!actions) return null;

  if (actions.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-card border border-border bg-surface px-4 py-3 text-sm text-ink-muted shadow-card">
        <Inbox className="h-4 w-4 shrink-0 text-primary" />
        No hay ninguna acción esperando tu aprobación.
      </div>
    );
  }

  const shown = actions.slice(0, OPEN);
  const rest = actions.slice(OPEN);

  return (
    <div className="space-y-2">
      <div className="field-label flex items-center gap-2 text-primary-ink">
        <Send className="h-3.5 w-3.5" />
        Esperando tu aprobación
        <span className="tabular rounded-pill border border-primary/25 bg-primary-soft px-1.5 text-micro font-semibold">
          {actions.length}
        </span>
      </div>
      {shown.map((action) => (
        <ProposedActionCard key={action.id} action={action} dense onSettled={onSettled} />
      ))}
      {rest.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-ink-muted transition-colors duration-150 hover:text-ink motion-reduce:transition-none">
            {rest.length === 1 ? 'Una más' : `${rest.length} más`}, sin abrir
          </summary>
          <div className="mt-2 space-y-2">
            {rest.map((action) => (
              <ProposedActionCard key={action.id} action={action} dense onSettled={onSettled} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Lo que llega cruzó un stream y, en una conversación reabierta, una fila de la
 * base. Se vuelve a comprobar en vez de confiarlo, y una fila sin `id` o sin
 * sello se cae en silencio: el sello es lo que viaja con el «Aprobar y enviar»
 * y lo que hace que un borrador que cambió entre el dibujo y el clic se rechace
 * en vez de mandar otra cosa. Sin él la tarjeta sería un botón que miente.
 */
function actionsOf(result: unknown): ActionView[] | null {
  if (!result || typeof result !== 'object') return null;
  const list = (result as { actions?: unknown }).actions;
  if (!Array.isArray(list)) return null;
  return list.filter(
    (row): row is ActionView =>
      !!row &&
      typeof row === 'object' &&
      typeof (row as ActionView).id === 'string' &&
      typeof (row as ActionView).contentHash === 'string',
  );
}
