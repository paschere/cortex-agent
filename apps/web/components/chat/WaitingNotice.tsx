'use client';

import { type WaitingNoticeData, waitingQuestion } from '@/lib/waiting-shape';
import { CornerDownLeft } from 'lucide-react';

/**
 * QUE EL CHAT TAMBIÉN HABLE PRIMERO — EN VOZ BAJA.
 *
 * Alguien que abre una conversación nueva viene a preguntar algo, y esa
 * intención manda. Así que esto no interrumpe: es una línea sobre las
 * sugerencias, del tamaño de una nota al pie, y desaparece en cuanto se escribe
 * el primer mensaje (quien la monta la condiciona a que el hilo esté vacío).
 * Con las cuatro colas vacías no dibuja ni un píxel.
 *
 * NO ES UN COMPONENTE DE LA PANTALLA VACÍA. `EmptyState.tsx` es la invitación a
 * preguntar y tiene su propio dueño; esto vive aparte y se monta un nivel más
 * arriba, en `ChatRoot`, para que ninguna de las dos cosas dependa de la otra.
 *
 * LA FRASE VIENE HECHA DEL SERVIDOR y sólo con los conteos: abrir un chat nuevo
 * no puede costar cuatro lecturas de listas. Ver `readWaitingNotice`.
 *
 * ── Y PREGUNTA, NO NAVEGA ─────────────────────────────────────────────────
 * Esto era un enlace a `/dashboard`: te decía que hay tres cosas esperando y te
 * mandaba fuera del chat a verlas. Ahora ejecuta el turno — la pregunta que
 * corresponde a las colas que tienen algo (`waitingQuestion`) — y la respuesta
 * llega con las tarjetas sobre las que se actúa, aquí mismo. Sacar a alguien de
 * la única pantalla que sabe contestar es la clase de atajo que hace que la
 * gente deje de usar el chat: preguntó, y le dieron un mapa.
 */
export function WaitingNotice({
  waiting,
  onAsk,
}: {
  waiting: WaitingNoticeData;
  onAsk: (text: string) => void;
}) {
  if (waiting.total <= 0) return null;

  const question = waitingQuestion(waiting.queues);

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-3">
      <button
        type="button"
        onClick={() => onAsk(question)}
        title={question}
        className="group flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded-card border border-border bg-surface px-3 py-2 text-left text-xs shadow-card transition-colors duration-150 hover:border-border-strong hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
        <span className="font-semibold text-ink">{waiting.sentence}</span>
        <span className="tabular min-w-0 truncate text-ink-faint">
          {waiting.queues.map((q) => `${q.label} ${q.count}`).join(' · ')}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 font-semibold text-primary">
          Preguntárselo
          <CornerDownLeft className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
        </span>
      </button>
    </div>
  );
}
