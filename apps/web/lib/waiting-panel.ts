import { type PanelId, panelForHref } from './panels/shape';
import type { WaitingNoticeData } from './waiting-shape';

/**
 * QUÉ PANEL ABRE EL AVISO DE LO QUE TE ESPERA.
 *
 * El aviso vive en la cabecera del chat y NO navega: sacar a alguien de la
 * única pantalla que sabe contestar es exactamente lo que este producto dejó de
 * hacer cuando el aviso era un enlace a `/dashboard`. Así que abre el panel de
 * al lado, que es la misma pantalla resumida sin desmontar la conversación —
 * ver la cabecera de `panels/shape.ts`.
 *
 * ===========================================================================
 * CUÁL DE LAS CUATRO COLAS, Y POR QUÉ NO TODAS TIENEN PANEL
 * ===========================================================================
 * Se elige la PRIMERA cola con panel en el orden de `WAITING_QUEUES`, que es el
 * orden en que `noticeFromCounts` ya devuelve las colas llenas: aprobaciones,
 * vencimientos, acciones, encargos. Ese orden no es alfabético, es de reloj —
 * una aprobación expira en minutos y un encargo atascado lleva días parado —, y
 * es el mismo orden que el resto del producto ya defiende.
 *
 * `/actions` NO tiene panel, a propósito y argumentado en `panels/shape.ts`:
 * una acción es un borrador ya redactado que se sigue vigilando después de
 * enviarse, y no es la cola que uno quiere ver sin soltar el chat. Así que si
 * lo ÚNICO que espera son correos redactados, esto devuelve `null` — y quien
 * dibuja el aviso hace entonces lo otro que sabe hacer: preguntárselo a Cortex
 * aquí mismo (`waitingQuestion`). Inventarle un panel a esa cola, o abrir el de
 * otra que está vacía, sería contestar una pregunta distinta de la que se hizo.
 *
 * Pura y sin base de datos: no recuenta nada. Recibe las colas que ya vienen
 * contadas de `countNavSignals` y sólo las traduce a un id de panel.
 */
export function panelForWaiting(queues: WaitingNoticeData['queues']): PanelId | null {
  for (const queue of queues) {
    const panel = panelForHref(queue.href);
    if (panel) return panel;
  }
  return null;
}
