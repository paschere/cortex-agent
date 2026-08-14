'use client';

import { WaitingIndex } from '@/app/(app)/dashboard/_components/WaitingIndex';
import type { StatusTone } from '@/lib/status-chip';
import type {
  WaitingIndex as WaitingIndexData,
  WaitingItem,
  WaitingQueueView,
} from '@/lib/waiting';
import { WAITING_QUEUES, type WaitingQueue } from '@/lib/waiting-shape';
import type { ResultViewProps } from './registry';

/**
 * «¿QUÉ ME ESPERA?», CONTESTADO DENTRO DEL CHAT.
 *
 * ===========================================================================
 * POR QUÉ ESTO NO PUEDE SER UNA FILA GRIS
 * ===========================================================================
 * Es la pregunta de apertura de cualquiera que abre Cortex por la mañana. Un
 * renglón plegado con un JSON detrás sería exactamente el fallo que el registro
 * de vistas existe para arreglar, y sobre la pregunta que más se hace.
 *
 * ===========================================================================
 * EL MISMO COMPONENTE QUE `/dashboard`, NO UNA VERSIÓN PARA EL CHAT
 * ===========================================================================
 * Las cuatro colas se dibujan con `WaitingIndex`, el bloque del panel — mismo
 * orden, mismos nombres, mismos enlaces, misma frase de cola vacía. Una segunda
 * maqueta de lo mismo se separaría de la primera en el segundo cambio, y en el
 * momento en que el chat y la pantalla enseñaran las colas distinto, una de las
 * dos estaría mintiendo sin que nadie pudiera decir cuál.
 *
 * Arriba va la FRASE, que es lo mismo que hace la pantalla: la escribe
 * `summarizeWaiting` a partir de los números, es pura y comprobada caso por
 * caso, y ninguna palabra suya sale de un modelo.
 *
 * ===========================================================================
 * LO QUE LLEGA SE VUELVE A COMPROBAR
 * ===========================================================================
 * Cruzó un stream y, en una conversación reabierta, una fila de la base. Una
 * cola sin nombre reconocible no se dibuja rara: no se dibuja. Y de aquí sólo
 * pueden llegar TIPOS de `@cortex/agent-tools` — este árbol es `'use client'` y
 * un valor de ese barril rompe el build de producción (`registry.test.ts`).
 */

const KNOWN = new Set<string>(WAITING_QUEUES);

const TONES = new Set<StatusTone>(['neutral', 'primary', 'emerald', 'amber', 'rose']);

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function items(value: unknown): WaitingItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw): WaitingItem[] => {
    if (!raw || typeof raw !== 'object') return [];
    const row = raw as Record<string, unknown>;
    const id = text(row.id);
    const title = text(row.title);
    if (!id || !title) return [];
    const tone = text(row.tone);
    return [
      {
        id,
        title,
        detail: text(row.detail),
        when: text(row.when) ?? '',
        tone: tone && TONES.has(tone as StatusTone) ? (tone as StatusTone) : 'neutral',
      },
    ];
  });
}

/**
 * El resultado de `inbox.overview` como el índice que dibuja el panel.
 *
 * `counts` se reconstruye desde las propias colas en vez de viajar aparte: el
 * conteo de cada cola YA viene en su bloque —y es el mismo que dibuja la barra
 * lateral, porque `readWaitingIndex` lo saca de `countNavSignals`—, así que
 * mandarlo dos veces sólo abriría la puerta a que las dos copias discreparan.
 */
function indexOf(result: unknown): WaitingIndexData | null {
  if (!result || typeof result !== 'object') return null;
  const raw = result as Record<string, unknown>;
  const sentence = text(raw.sentence);
  if (!sentence || !Array.isArray(raw.queues)) return null;

  const queues: WaitingQueueView[] = raw.queues.flatMap((entry): WaitingQueueView[] => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const queue = text(row.queue);
    if (!queue || !KNOWN.has(queue)) return [];
    return [
      {
        queue: queue as WaitingQueue,
        label: text(row.label) ?? queue,
        href: text(row.href) ?? '/dashboard',
        count: typeof row.count === 'number' ? row.count : 0,
        items: items(row.items),
        error: text(row.error),
      },
    ];
  });
  if (queues.length === 0) return null;

  const counts = { approvals: 0, commitments: 0, actions: 0, errands: 0 };
  for (const queue of queues) counts[queue.queue] = queue.count;

  return {
    counts,
    total: typeof raw.total === 'number' ? raw.total : queues.reduce((n, q) => n + q.count, 0),
    sentence,
    queues,
  };
}

export function WaitingOverview({ result }: ResultViewProps) {
  const index = indexOf(result);
  if (!index) return null;

  return (
    <div className="space-y-2">
      <p
        className={
          index.total > 0
            ? 'text-base font-semibold leading-snug text-ink'
            : 'text-base font-semibold leading-snug text-ink-muted'
        }
      >
        {index.sentence}
      </p>
      <WaitingIndex index={index} />
    </div>
  );
}
