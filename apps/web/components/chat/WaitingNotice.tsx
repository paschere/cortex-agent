'use client';

import { usePanel } from '@/components/panel/PanelHost';
import { panelForWaiting } from '@/lib/waiting-panel';
import { hasWaitingWork, type WaitingNoticeData, waitingQuestion } from '@/lib/waiting-shape';
import { clsx } from 'clsx';

/**
 * LO QUE TE ESPERA, SIEMPRE VISIBLE Y EN VOZ BAJA.
 *
 * ===========================================================================
 * POR QUÉ SE MUDÓ A LA CABECERA
 * ===========================================================================
 * Esto era una tarjeta sobre la pantalla vacía: se caía en cuanto había un
 * primer mensaje y no existía en una conversación reabierta. O sea que lo que
 * Cortex dejó hecho de noche sólo se anunciaba en los diez segundos que dura un
 * chat en blanco, que es casi lo mismo que no anunciarlo. Ahora es una línea
 * permanente en la cabecera del chat, del tamaño de una nota al pie, en la
 * pantalla donde esta gente pasa el día.
 *
 * Permanente no es insistente: un punto, una frase y nada más. Con las cuatro
 * colas vacías no dibuja ni un píxel.
 *
 * ===========================================================================
 * ABRE EL PANEL DE AL LADO; NO NAVEGA Y NO PREGUNTA (SALVO QUE NO QUEDE OTRA)
 * ===========================================================================
 * Antes enlazaba a `/dashboard` —te decía que hay tres cosas esperando y te
 * sacaba del chat a verlas—, y después preguntaba. Preguntar era mejor que
 * navegar y sigue siendo el respaldo, pero cuesta un turno entero para leer una
 * lista que el panel ya sabe pintar: `PANELS` corre la misma herramienta y la
 * dibuja con el mismo componente, al lado, sin desmontar la conversación ni
 * gastar una llamada al modelo.
 *
 * Cuál panel lo decide `panelForWaiting`, y devuelve `null` cuando lo único que
 * espera son correos redactados, que es la cola que a propósito no tiene panel.
 * En ese caso —y en cualquier sitio donde no haya un `PanelProvider` encima— se
 * cae al comportamiento anterior: preguntárselo a Cortex aquí mismo. Ninguna de
 * las dos ramas te saca de la conversación.
 *
 * LA FRASE VIENE HECHA DEL SERVIDOR y sólo con los conteos: abrir un chat no
 * puede costar cuatro lecturas de listas. Ver `readWaitingNotice`.
 */
export function WaitingNotice({
  waiting,
  onAsk,
}: {
  waiting: WaitingNoticeData;
  onAsk: (text: string) => void;
}) {
  const { open, available } = usePanel();

  if (!hasWaitingWork(waiting)) return null;

  const panel = available && !waiting.lead ? panelForWaiting(waiting.queues) : null;
  const question = waiting.lead?.ask ?? waitingQuestion(waiting.queues);
  const detail = waiting.queues.map((q) => `${q.label} ${q.count}`).join(' · ');

  return (
    <button
      type="button"
      onClick={() => (panel ? open(panel) : onAsk(question))}
      title={`${waiting.sentence} ${detail}`}
      aria-label={`${waiting.sentence} ${panel ? 'Abrir el panel' : 'Preguntárselo a Cortex'}`}
      className={clsx(
        'group flex min-w-0 shrink items-center gap-2 rounded-pill px-2.5 py-1.5',
        'text-xs text-ink-muted transition-colors duration-150',
        'hover:bg-amber-soft hover:text-ink focus-visible:outline-none focus-visible:ring-2',
        'focus-visible:ring-primary/40 motion-reduce:transition-none',
      )}
    >
      {/* El punto es todo el énfasis que se permite una línea permanente. */}
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" aria-hidden />
      {waiting.total > 0 ? (
        <span className="tabular font-semibold text-ink sm:hidden">{waiting.total}</span>
      ) : null}
      <span className="hidden min-w-0 truncate font-medium sm:inline">{waiting.sentence}</span>
    </button>
  );
}
