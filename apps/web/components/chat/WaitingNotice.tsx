'use client';

import type { WaitingNoticeData } from '@/lib/waiting-shape';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

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
 */
export function WaitingNotice({ waiting }: { waiting: WaitingNoticeData }) {
  if (waiting.total <= 0) return null;

  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-3">
      <Link
        href="/dashboard"
        className="group flex flex-wrap items-center gap-x-2 gap-y-1 rounded-card border border-border bg-surface px-3 py-2 text-[12px] shadow-card transition-colors duration-150 hover:border-border-strong hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber" />
        <span className="font-semibold text-ink">{waiting.sentence}</span>
        <span className="tabular min-w-0 truncate text-ink-faint">
          {waiting.queues.map((q) => `${q.label} ${q.count}`).join(' · ')}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 font-semibold text-primary">
          Verlo
          <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
        </span>
      </Link>
    </div>
  );
}
