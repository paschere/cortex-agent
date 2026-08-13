import { Panel } from '@/components/ui/panel';
import { chipClass } from '@/lib/status-chip';
import type { WaitingIndex as WaitingIndexData, WaitingQueueView } from '@/lib/waiting';
import { QUEUE_EMPTY, type WaitingQueue } from '@/lib/waiting-shape';
import { clsx } from 'clsx';
import {
  ArrowRight,
  Briefcase,
  CalendarClock,
  CheckCircle2,
  Inbox,
  Send,
  TriangleAlert,
} from 'lucide-react';
import Link from 'next/link';

/**
 * LAS CUATRO COLAS, UNA AL LADO DE OTRA, SIN MEZCLARSE.
 *
 * Cada bloque es su propia cola: su nombre, su conteo, su enlace y dos o tres
 * de sus elementos con el ASUNTO REAL. «Cotización a Servientrega, redactada
 * hace nueve días» es lo que hace abrir la pantalla; un 3 no lo hace, y eso ya
 * lo dice la barra lateral.
 *
 * Las cuatro se dibujan siempre, también vacías. Esconder la cola sin trabajo
 * dejaría el índice diciendo cosas distintas cada día y volvería ambiguo el
 * único mensaje que de verdad importa cuando no hay nada: que no hay nada. Una
 * cola vacía cuesta una línea y promete lo que dejaría ahí Cortex.
 */

const ICON: Record<WaitingQueue, React.ComponentType<{ className?: string }>> = {
  approvals: Inbox,
  commitments: CalendarClock,
  actions: Send,
  errands: Briefcase,
};

export function WaitingIndex({ index }: { index: WaitingIndexData }) {
  return (
    <Panel className="animate-rise mb-4 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="field-label">Lo que te espera</div>
        <div className="tabular text-[11px] text-ink-faint">
          {index.total === 0 ? 'las cuatro colas están vacías' : `${index.total} en cuatro colas`}
        </div>
      </div>
      <div className="rule-double" />
      <div className="grid grid-cols-1 gap-px bg-border lg:grid-cols-2">
        {index.queues.map((queue) => (
          <QueueBlock key={queue.queue} queue={queue} />
        ))}
      </div>
    </Panel>
  );
}

function QueueBlock({ queue }: { queue: WaitingQueueView }) {
  const Icon = ICON[queue.queue];
  const quiet = queue.count === 0 && queue.items.length === 0 && !queue.error;

  return (
    <section className="bg-surface px-4 py-3.5">
      <div className="flex items-center gap-2">
        <Icon className={clsx('h-3.5 w-3.5 shrink-0', quiet ? 'text-ink-faint' : 'text-primary')} />
        <Link
          href={queue.href}
          className="group inline-flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-ink transition-colors hover:text-primary"
        >
          <span className="truncate">{queue.label}</span>
          <ArrowRight className="h-3 w-3 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
        </Link>
        {queue.count > 0 && (
          <span className={clsx(chipClass('amber'), 'ml-auto')}>{queue.count}</span>
        )}
      </div>

      {/* Una lista que no se pudo leer no se dibuja vacía. El conteo de arriba
          viene de otra consulta y puede seguir en pie; lo que falta es el
          detalle, y eso se dice. Ver la cabecera de lib/waiting.ts. */}
      {queue.error ? (
        <p className="mt-2 flex items-start gap-1.5 rounded-sm border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-[11.5px] leading-snug text-rose">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{queue.error}</span>
        </p>
      ) : queue.items.length > 0 ? (
        <ul className="mt-2 space-y-px">
          {queue.items.map((item) => (
            <li key={item.id}>
              <Link
                href={queue.href}
                className="block rounded-sm px-1.5 py-1.5 transition-colors hover:bg-surface-2 focus:outline-none focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
              >
                <div className="flex items-start gap-2">
                  <span
                    className={clsx(
                      'mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full',
                      item.tone === 'rose'
                        ? 'bg-rose'
                        : item.tone === 'amber'
                          ? 'bg-amber'
                          : 'bg-primary',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[12.5px] font-medium leading-snug text-ink">
                      {item.title}
                    </div>
                    <div className="tabular mt-0.5 truncate text-[11px] text-ink-faint">
                      {[item.detail, item.when].filter(Boolean).join(' · ')}
                    </div>
                  </div>
                </div>
              </Link>
            </li>
          ))}
          {queue.count > queue.items.length && (
            <li className="px-1.5 pt-1">
              <Link
                href={queue.href}
                className="text-[11.5px] font-semibold text-primary hover:text-primary-strong"
              >
                y {queue.count - queue.items.length} más
              </Link>
            </li>
          )}
        </ul>
      ) : queue.count > 0 ? (
        // El conteo dice que hay algo y la lista llegó vacía. Pasa cuando algo
        // se resolvió entre las dos consultas, y también cuando la lectura del
        // detalle se rindió en silencio. Ninguna de las dos justifica callarse.
        <p className="mt-2 px-1.5 text-[11.5px] leading-snug text-ink-muted">
          Hay {queue.count} esperando, pero el detalle no llegó. Ábrela para verlos.
        </p>
      ) : (
        <p className="mt-2 flex items-center gap-1.5 px-1.5 text-[11.5px] text-ink-faint">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald" />
          {QUEUE_EMPTY[queue.queue]}
        </p>
      )}
    </section>
  );
}
