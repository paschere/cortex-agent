import { UndoButton } from '@/app/(app)/actividad/_components/UndoButton';
import type { ActivityRowView } from '@/lib/hoy/ops';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';

/**
 * «LO QUE HIZO CORTEX», COMO TABLA: hora, qué, sobre qué y quién lo aprobó o
 * lo dejó hacer solo. «Deshacer» sale sólo en lo que se puede deshacer, con el
 * mismo botón (y la misma acción) que /actividad.
 */
export function ActivityTable({
  rows,
  canUndo = true,
}: { rows: ActivityRowView[]; canUndo?: boolean }) {
  if (rows.length === 0) return null;
  return (
    <section aria-label="Lo que hizo Cortex" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <h2 className="title-display flex-1 text-[1.75rem] leading-tight text-ink">
          Lo que hizo Cortex
        </h2>
        <Link
          href="/actividad"
          className="inline-flex items-center gap-1 text-[0.8125rem] font-semibold text-primary-ink hover:underline"
        >
          Ver todo
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">Las últimas acciones de Cortex</caption>
          <thead>
            <tr className="text-left text-xs text-ink-faint">
              <th scope="col" className="whitespace-nowrap py-2 pr-3 font-semibold">
                Hora
              </th>
              <th scope="col" className="py-2 pr-3 font-semibold">
                Qué
              </th>
              <th scope="col" className="hidden py-2 pr-3 font-semibold sm:table-cell">
                Sobre qué
              </th>
              <th scope="col" className="hidden py-2 pr-3 font-semibold md:table-cell">
                Quién
              </th>
              <th scope="col" className="py-2 text-right font-semibold">
                <span className="sr-only">Deshacer</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border align-top">
                <td className="tabular whitespace-nowrap py-2.5 pr-3 font-mono text-xs text-ink-faint">
                  {r.when}
                </td>
                <td className="py-2.5 pr-3 text-ink">
                  <span className={r.failed ? 'font-semibold text-rose' : undefined}>{r.text}</span>
                  <span className="mt-0.5 block text-xs text-ink-faint md:hidden">{r.who}</span>
                </td>
                <td className="hidden py-2.5 pr-3 sm:table-cell">
                  <span className="rounded-pill bg-surface-2 px-2.5 py-0.5 text-xs font-semibold text-ink-muted">
                    {r.on}
                  </span>
                </td>
                <td className="hidden whitespace-nowrap py-2.5 pr-3 text-ink-muted md:table-cell">
                  {r.who}
                </td>
                <td className="py-2 text-right">
                  {canUndo && r.undoLabel ? (
                    <UndoButton eventIds={r.eventIds} label={r.undoLabel} />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
