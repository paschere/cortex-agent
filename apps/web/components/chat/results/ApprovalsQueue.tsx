'use client';

import { PendingActionCard } from '@/components/approvals/PendingActionCard';
import { STAGED_VIA_LABEL } from '@/lib/approvals-shape';
import type { PendingApproval } from '@cortex/agent-tools';
import { Inbox, ShieldAlert } from 'lucide-react';
import { PinSurface } from '../PinSurface';
import type { ResultViewProps } from './registry';

/**
 * «¿QUÉ ESPERA MI APROBACIÓN?», CONTESTADO CON EL BOTÓN PUESTO.
 *
 * ===========================================================================
 * QUÉ SE ARREGLA AQUÍ
 * ===========================================================================
 * `mcp_pending_actions` es la única cola de aprobaciones que existe, y el chat
 * web no escribe en ella nunca: cuando una llamada se para en un turno del
 * chat, se resuelve en ese mismo turno con el centinela
 * `__requires_confirmation`. Lo que llenaba la tabla eran las OTRAS
 * superficies — Claude por MCP, Google Chat, WhatsApp — así que lo que quedó
 * pendiente anoche era invisible justo desde donde la gente pregunta las cosas.
 * Preguntar «¿qué espera mi aprobación?» devolvía, en el mejor de los casos,
 * una fila gris con un JSON detrás de un chevron.
 *
 * Ahora devuelve las tarjetas, y las tarjetas son LAS MISMAS de `/approvals`
 * — el mismo componente, no una versión para el chat. Ver su cabecera para por
 * qué eso no es negociable.
 *
 * ===========================================================================
 * LO QUE ESTA VISTA NO TIENE
 * ===========================================================================
 * El payload. `approvals.list` no lo devuelve —su esquema de salida no tiene
 * dónde meterlo— así que cada tarjeta llega sin él y lo pide ella misma, a una
 * ruta con sesión, sólo si alguien lo despliega. Y no hay ningún camino por el
 * que el modelo pueda aprobar: el botón es un `fetch` desde este árbol de
 * cliente, que él no puede invocar.
 *
 * ===========================================================================
 * DE DÓNDE SALEN LAS ETIQUETAS DE ORIGEN
 * ===========================================================================
 * De `lib/approvals-shape.ts`, que es la copia del navegador de un dato que
 * vive en `packages/agent-tools/src/approvals/shape.ts`: este árbol es
 * `'use client'` y de ese paquete sólo pueden llegar TIPOS, porque un valor
 * arrastra `node:dns` al bundle y rompe el build de producción
 * (`registry.test.ts` lo vigila). `lib/approvals-parity.test.ts` compara las
 * dos copias en Node y falla si se separan.
 */

/**
 * Lo que llega cruzó un stream y, en una conversación reabierta, una fila de la
 * base. Se vuelve a comprobar aquí en vez de confiarlo: una tarjeta sin `id` no
 * es una tarjeta con un botón roto, es una que no se dibuja.
 */
function pendingOf(result: unknown): PendingApproval[] | null {
  if (!result || typeof result !== 'object') return null;
  const list = (result as { pending?: unknown }).pending;
  if (!Array.isArray(list)) return null;
  return list.filter(
    (row): row is PendingApproval =>
      !!row &&
      typeof row === 'object' &&
      typeof (row as PendingApproval).id === 'string' &&
      typeof (row as PendingApproval).toolId === 'string' &&
      typeof (row as PendingApproval).expiresAt === 'string',
  );
}

export function ApprovalsQueue({ result, onSettled, toolCallId }: ResultViewProps) {
  const pending = pendingOf(result);
  if (!pending) return null;

  if (pending.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-card border border-border bg-surface px-4 py-3 text-sm text-ink-muted shadow-card">
        <Inbox className="h-4 w-4 shrink-0 text-primary" />
        No hay nada esperando tu permiso ahora mismo.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="field-label flex items-center gap-2 text-amber">
        <ShieldAlert className="h-3.5 w-3.5" />
        Esperando tu permiso
        <span className="tabular rounded-pill border border-amber/40 bg-amber-soft px-1.5 text-micro font-semibold">
          {pending.length}
        </span>
        <span className="ml-auto">
          <PinSurface surface="approvals" hidden={toolCallId.startsWith('panel:')} />
        </span>
      </div>
      {pending.map((row) => (
        <PendingActionCard
          key={row.id}
          id={row.id}
          toolId={row.toolId}
          summary={row.summary}
          expiresAt={row.expiresAt}
          originLabel={row.via ? (STAGED_VIA_LABEL[row.via] ?? null) : null}
          onSettled={onSettled}
        />
      ))}
    </div>
  );
}
