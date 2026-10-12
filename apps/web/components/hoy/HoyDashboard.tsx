import type { HoyView } from '@/lib/hoy/view';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { ActivityTable } from './ActivityTable';
import { HoyHero } from './HoyHero';
import { OpsRow } from './OpsRow';
import { type DecideFn, TodoList } from './TodoList';

/**
 * «HOY»: UN CUADERNO CON LOS NÚMEROS ADENTRO.
 *
 * Arriba, el saludo y una frase escrita con reglas (no un modelo): cómo está la
 * caja, qué te deben y cuántas cosas te necesitan. Después la cifra de la caja
 * con su gráfico y la tira de indicadores; «Para ti, hoy» como lista de
 * pendientes con lo que Cortex ya dejó listo; quién te debe; y una línea de lo
 * que hizo. Sin la plata a la vista (módulo apagado), la página sigue siendo
 * el saludo, los pendientes y lo hecho. Se pinta igual en /piloto y en
 * /v/hoy-showcase.
 */
export function HoyDashboard({ view, decide }: { view: HoyView; decide: DecideFn }) {
  return (
    <div className="mx-auto flex w-full max-w-[56rem] flex-col gap-10 pb-16 pt-2 sm:pt-6">
      <header className="flex flex-col gap-3">
        <p className="text-[0.8125rem] font-semibold text-ink-faint first-letter:uppercase">
          {view.dateLabel}
        </p>
        <h1 className="title-display text-[2.4rem] leading-[1.08] text-ink sm:text-[2.9rem]">
          {view.greeting}
          {view.firstName ? `, ${view.firstName}` : ''}.
        </h1>
        <p className="font-display max-w-[46rem] text-balance text-xl leading-relaxed text-ink-muted sm:text-[1.3rem]">
          {view.narrative.map((p, i) =>
            p.mark ? (
              <mark
                // biome-ignore lint/suspicious/noArrayIndexKey: frase fija, no se reordena.
                key={i}
                className="bg-transparent text-ink [background:linear-gradient(transparent_58%,rgb(var(--amber)/0.35)_58%)]"
              >
                {p.text}
              </mark>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: frase fija, no se reordena.
              <span key={i}>{p.text}</span>
            ),
          )}
        </p>
      </header>

      {view.money && view.money.metrics.length > 0 && (
        <HoyHero metrics={view.money.metrics} kpis={view.money.kpis} today={view.today} />
      )}

      {view.ops && view.ops.length > 0 && <OpsRow kpis={view.ops} />}

      <TodoList
        todos={view.todos}
        done={view.done}
        canDecide={view.canDecide}
        decide={decide}
        more={view.todosMore}
        moreHref={view.todosMoreHref}
      />

      {view.due && view.due.parties.length > 0 && (
        <section aria-label="Quién te debe" className="flex flex-col gap-2">
          <div className="flex items-baseline gap-3">
            <h2 className="title-display flex-1 text-[1.75rem] leading-tight text-ink">
              Quién te debe
            </h2>
            <Link
              href={view.due.href}
              className="text-[0.8125rem] font-semibold text-primary-ink hover:underline"
            >
              Abrir la cartera
            </Link>
          </div>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Los clientes que más te deben: en total {view.due.total}, de lo cual{' '}
              {view.due.overdue} está vencido.
            </caption>
            <thead>
              <tr className="text-left text-xs text-ink-faint">
                <th scope="col" className="py-2 pr-3 font-semibold">
                  Cliente
                </th>
                <th scope="col" className="hidden py-2 pr-3 text-right font-semibold sm:table-cell">
                  Facturas
                </th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">
                  Debe
                </th>
                <th scope="col" className="py-2 text-right font-semibold">
                  Estado
                </th>
              </tr>
            </thead>
            <tbody>
              {view.due.parties.map((p) => (
                <tr key={p.name} className="border-t border-border">
                  <td className="max-w-0 truncate py-3 pr-3 font-semibold text-ink">{p.name}</td>
                  <td className="tabular hidden py-3 pr-3 text-right text-ink-muted sm:table-cell">
                    {p.count}
                  </td>
                  <td className="tabular whitespace-nowrap py-3 pr-3 text-right font-semibold tabular-nums text-ink">
                    {p.amount}
                  </td>
                  <td className="py-3 text-right">
                    <span
                      className={
                        p.late
                          ? 'whitespace-nowrap rounded-pill bg-rose-soft px-2.5 py-0.5 text-xs font-semibold text-rose'
                          : 'whitespace-nowrap text-xs text-ink-faint'
                      }
                    >
                      {p.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {view.activity && view.activity.length > 0 && <ActivityTable rows={view.activity} />}

      {view.closing && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-5 text-sm text-ink-muted">
          <span className="font-display text-base">{view.closing.text}</span>
          <Link
            href={view.closing.href}
            className="inline-flex items-center gap-1 font-semibold text-primary-ink hover:underline"
          >
            {view.closing.hrefLabel}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
          {view.panelHref && (
            <Link
              href={view.panelHref}
              className="ml-auto text-xs font-semibold text-ink-faint hover:text-ink"
            >
              Piloto automático
            </Link>
          )}
        </p>
      )}
    </div>
  );
}
