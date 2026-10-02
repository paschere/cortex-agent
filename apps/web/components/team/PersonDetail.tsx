import { Panel } from '@/components/ui/panel';
import type { PersonScreen, TypeSection } from '@/lib/team/screen';
import {
  ArrowLeft,
  CalendarOff,
  ListTodo,
  MessageSquareText,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import Link from 'next/link';
import { AwayDaysEditor } from './AwayDaysEditor';
import {
  Avatar,
  ChoiceRow,
  ItemList,
  MetricGrid,
  Pill,
  Section,
  WeekBars,
  pillLink,
} from './pieces';
import type { TeamActions } from './types';

/**
 * /team/[persona]: todo lo que se mide de una persona, por tipo de trabajo,
 * con sus últimas ocho semanas, lo que tiene abierto y sus días fuera. Lo ve
 * quien reparte el trabajo y la persona misma: nada aquí es secreto para ella.
 */
export function PersonDetail({ screen, actions }: { screen: PersonScreen; actions: TeamActions }) {
  const { person } = screen;
  return (
    <div className="space-y-6">
      {screen.links.team && (
        <Link
          href={screen.links.team}
          className="inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Equipo
        </Link>
      )}
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <Avatar initials={person.initials} size="lg" />
          <div className="min-w-0">
            <h1 className="text-balance text-xl font-extrabold text-ink md:text-display">
              {person.name}
            </h1>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
              <span>
                {[person.team, person.role].filter(Boolean).join(' · ') || 'Sin equipo asignado'}
              </span>
              {person.awayToday && (
                <Pill tone="sky">
                  <CalendarOff className="h-3 w-3" aria-hidden />
                  Fuera hoy
                </Pill>
              )}
            </p>
          </div>
        </div>
        {screen.links.write && (
          <Link href={screen.links.write} className={pillLink}>
            <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
            Escribirle
          </Link>
        )}
      </header>

      <ChoiceRow label="Período" choices={screen.periods} />

      <Panel className="p-5 sm:p-6">
        <p className="field-label flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" aria-hidden />
          {screen.self
            ? 'Tu período, en palabras'
            : `Lo que ${person.firstName} lee en «Mi semana»`}
        </p>
        <p className="mt-2 max-w-3xl text-base leading-relaxed text-ink">{screen.description}</p>
        {screen.self && (
          <p className="mt-2 text-xs text-ink-muted">
            Está escrito para ti: así lo lee también quien reparte el trabajo.
          </p>
        )}
      </Panel>

      <Section
        id="cifras"
        title="Por tipo de trabajo"
        subtitle={`${screen.period.label} (${screen.period.range}). Flechas contra el período anterior; «equipo» es la mediana en el mismo tipo.`}
        icon={<TrendingUp className="h-4 w-4" aria-hidden />}
      >
        <div className="space-y-6">
          {screen.sections.map((s) => (
            <TypeBlock key={s.workType ?? 'all'} section={s} />
          ))}
        </div>
      </Section>

      <Section
        id="abiertos"
        title="Lo que tiene abierto"
        subtitle={`${screen.openTotal} abiertos, ${screen.overdueTotal} vencidos. Lo vencido primero, después lo que vence antes.`}
        icon={<ListTodo className="h-4 w-4" aria-hidden />}
      >
        <ItemList
          items={screen.open}
          actions={screen.self ? actions : null}
          empty="No tiene nada abierto."
        />
        {screen.openTotal > screen.open.length && (
          <p className="mt-2 text-xs text-ink-muted">
            Se muestran los primeros {screen.open.length} de {screen.openTotal}.
          </p>
        )}
      </Section>

      <Section
        id="dias-fuera"
        title="Días fuera"
        subtitle="Vacaciones, incapacidad, un permiso: esos días no cuentan en contra."
        icon={<CalendarOff className="h-4 w-4" aria-hidden />}
      >
        {screen.canEditAway ? (
          <AwayDaysEditor
            personId={person.id}
            firstName={person.firstName}
            self={screen.self}
            initial={person.awayDays}
            today={screen.today}
            saveAway={actions.saveAway}
          />
        ) : (
          <p className="text-sm text-ink-muted">
            {person.awayDays.length
              ? `${person.awayDays.length} días fuera anotados.`
              : 'No tiene días fuera anotados.'}{' '}
            Los anota la persona o quien administra.
          </p>
        )}
      </Section>
    </div>
  );
}

export function TypeBlock({ section }: { section: TypeSection }) {
  return (
    <div className="grid gap-4 border-t border-border pt-5 first:border-t-0 first:pt-0 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0">
        <h3 className="mb-2 text-base font-bold text-ink">{section.label}</h3>
        <MetricGrid metrics={section.metrics} output={section.output} />
        {section.note && <p className="mt-2 text-xs text-ink-muted">{section.note}</p>}
      </div>
      <div className="lg:pt-8">
        <WeekBars weeks={section.weeks} label={section.label} />
      </div>
    </div>
  );
}
