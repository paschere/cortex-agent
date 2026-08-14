import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { readJournal } from '@/lib/journal';
import { requireSession } from '@/lib/session';
import { ArrowLeft, Hourglass, ListChecks } from 'lucide-react';
import Link from 'next/link';
import { JournalGaps, JournalQuiet, JournalRow } from '../_components/DayJournal';

/**
 * LA JORNADA COMPLETA.
 *
 * La columna de /dashboard enseña las últimas siete líneas; esto las enseña
 * todas, separadas por día, que es donde esa separación significa algo: «esto
 * pasó anoche mientras no estabas» es una frase distinta de «esto pasó hace un
 * rato».
 *
 * Cuesta lo mismo que la columna —la misma llamada a `readJournal`, la misma
 * ventana de 48 horas— porque es la misma lectura. Ver el presupuesto en la
 * cabecera de `lib/journal.ts`.
 *
 * No tiene entrada en el menú a propósito: se llega desde la columna de inicio,
 * que es donde alguien se pregunta «¿y qué más hizo?». Una entrada más en la
 * barra lateral sería una pantalla que hay que acordarse de abrir, y esto
 * existe justamente porque nadie abre las pantallas que hay que recordar.
 */

export const dynamic = 'force-dynamic';

export default async function JornadaPage() {
  const user = await requireSession();
  const journal = await readJournal(user.organization.id, user.id, {
    isAdmin: user.role === 'org_admin',
  });

  return (
    <>
      <PageHeader
        title="La jornada de Cortex"
        subtitle="Todo lo que hice anoche y hoy, con la hora. Nada de esto lo pediste dos veces."
        icon={<ListChecks className="h-5 w-5" />}
        actions={
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 motion-reduce:transform-none motion-reduce:transition-none"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Volver a inicio
          </Link>
        }
      />

      <Panel className="animate-rise mb-4 p-5">
        <p
          className={
            journal.total > 0
              ? 'text-base font-bold leading-snug tracking-tight text-ink'
              : 'text-base font-semibold leading-snug text-ink-muted'
          }
        >
          {journal.headline}
        </p>
        {journal.total > 0 && (
          <p className="tabular mt-1 text-xs text-ink-faint">
            {journal.total} {journal.total === 1 ? 'cosa' : 'cosas'} en las últimas 48 horas
            {journal.attention > 0 && `, ${journal.attention} sin salir como debía`}.
          </p>
        )}
      </Panel>

      {journal.days.length === 0 ? (
        <Panel className="animate-rise mb-4 overflow-hidden">
          <JournalQuiet>
            Aquí queda lo que hago solo: reviso los vencimientos a las 6:00, dejo correos redactados
            a las 6:30 y anoto de madrugada lo que aprendo de cómo trabajas.
          </JournalQuiet>
        </Panel>
      ) : (
        journal.days.map((day) => (
          <Panel key={day.date} className="animate-rise mb-4 overflow-hidden">
            <div className="flex items-baseline justify-between gap-3 px-4 py-3">
              <div className="field-label">{day.label}</div>
              <div className="tabular text-micro text-ink-faint">{day.date}</div>
            </div>
            <div className="rule-double" />
            <ol className="px-2 py-2">
              {day.lines.map((line) => (
                <JournalRow key={line.id} line={line} day={null} />
              ))}
            </ol>
          </Panel>
        ))
      )}

      {/* Lo que salió hace días y sigue callado. Va abajo y aparte porque no
          tiene hora de hoy: no es parte de la jornada, es lo que la jornada
          arrastra. Callarlo sería el sesgo que hace increíble un parte. */}
      {journal.lingering.length > 0 && (
        <Panel className="animate-rise mb-4 overflow-hidden">
          <div className="px-4 py-3">
            <div className="field-label">Y sigue sin moverse</div>
          </div>
          <div className="rule-double" />
          <ul className="space-y-1 px-4 py-3">
            {journal.lingering.map((line) => (
              <li key={line.id} className="flex items-start gap-2 text-xs leading-snug">
                <Hourglass className="mt-[3px] h-3.5 w-3.5 shrink-0 text-amber" />
                {line.href ? (
                  <Link href={line.href} className="text-ink-muted hover:text-primary">
                    {line.text}
                  </Link>
                ) : (
                  <span className="text-ink-muted">{line.text}</span>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {journal.gaps.length > 0 && (
        <Panel className="animate-rise overflow-hidden">
          <div className="px-4 py-3">
            <div className="field-label">Lo que no pude leer</div>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Esta parte de la jornada no aparece arriba. No es que no hubiera pasado nada: es que
              la consulta falló, y una pantalla vacía y una rota significan lo contrario.
            </p>
          </div>
          <JournalGaps gaps={journal.gaps} />
        </Panel>
      )}
    </>
  );
}
