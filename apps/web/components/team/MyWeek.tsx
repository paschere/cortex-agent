import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import type { PersonScreen } from '@/lib/team/screen';
import {
  CalendarCheck,
  CalendarOff,
  CircleCheck,
  Eye,
  ListTodo,
  MessageSquareText,
  TrendingUp,
  UsersRound,
} from 'lucide-react';
import Link from 'next/link';
import { AwayDaysEditor } from './AwayDaysEditor';
import { TypeBlock } from './PersonDetail';
import { ChoiceRow, ItemList, Pill, Section, pillLink } from './pieces';
import type { TeamActions } from './types';

/**
 * «MI SEMANA»: lo que cada persona ve de sí misma. Su párrafo, lo que la
 * espera (lo vencido arriba, con su enlace y, donde se puede, «Marcar hecho»),
 * lo que mejoró, sus cifras y sus días fuera. Tono de apoyo: sus propios
 * números, sin compararla con nadie con nombre.
 */
export function MyWeek({
  screen,
  actions,
  askHref,
  teamHref,
}: {
  screen: PersonScreen;
  actions: TeamActions;
  /** El chat, para pedir ayuda con lo que la espera. */
  askHref: string;
  /** /team, si quien mira ve al equipo. */
  teamHref: string | null;
}) {
  const { person } = screen;
  return (
    <>
      <PageHeader
        title="Mi semana"
        subtitle={`Hola, ${person.firstName}. Esto es lo que se mide de tu trabajo ${screen.period.label.toLowerCase()} (${screen.period.range}). Todo lo que se mide de ti está aquí.`}
        icon={<CalendarCheck className="h-5 w-5" />}
        actions={
          <>
            {teamHref && (
              <Link href={teamHref} className={pillLink}>
                <UsersRound className="h-3.5 w-3.5" aria-hidden />
                Equipo
              </Link>
            )}
            <Link href={askHref} className={pillLink}>
              <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
              Pedir ayuda a Cortex
            </Link>
          </>
        }
      />
      <div className="space-y-6">
        <ChoiceRow label="Período" choices={screen.periods} />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Panel className="p-5 sm:p-6">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone="primary">
                <span className="tabular">{screen.doneTotal}</span> cerrados
              </Pill>
              <Pill tone={screen.overdueTotal ? 'amber' : 'neutral'}>
                <span className="tabular">{screen.openTotal}</span> abiertos
                {screen.overdueTotal ? (
                  <>
                    {' · '}
                    <span className="tabular">{screen.overdueTotal}</span> vencidos
                  </>
                ) : null}
              </Pill>
              {person.awayToday && (
                <Pill tone="sky">
                  <CalendarOff className="h-3 w-3" aria-hidden />
                  Hoy estás fuera
                </Pill>
              )}
            </div>
            <p className="mt-3 text-base leading-relaxed text-ink">{screen.description}</p>
          </Panel>

          <Panel className="p-5 sm:p-6">
            <p className="field-label flex items-center gap-1.5">
              <TrendingUp className="h-3.5 w-3.5 text-emerald" aria-hidden />
              Lo que mejoró
            </p>
            {screen.improved.length ? (
              <ul className="mt-3 space-y-2">
                {screen.improved.map((line) => (
                  <li key={line} className="flex items-start gap-2 text-sm text-ink">
                    <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald" aria-hidden />
                    <span className="tabular-nums">{line}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-ink-muted">
                Todavía no hay suficiente para comparar contra tu período anterior. Con unas semanas
                más de trabajo registrado, aquí aparece lo que va mejorando.
              </p>
            )}
          </Panel>
        </div>

        <Section
          id="te-espera"
          title="Lo que te espera"
          subtitle="Lo vencido primero, después lo que vence antes. Cada ítem abre donde vive."
          icon={<ListTodo className="h-4 w-4" aria-hidden />}
        >
          <ItemList
            items={screen.open}
            actions={actions}
            empty="No tienes nada abierto. Buen trabajo."
          />
          {screen.openTotal > screen.open.length && (
            <p className="mt-2 text-xs text-ink-muted">
              Se muestran los primeros {screen.open.length} de {screen.openTotal}.
            </p>
          )}
        </Section>

        <Section
          id="mis-cifras"
          title="Tus cifras"
          subtitle="Contra tu propio período anterior; «equipo» es la mediana del equipo en el mismo tipo de trabajo, sin nombres."
          icon={<TrendingUp className="h-4 w-4" aria-hidden />}
        >
          <div className="space-y-6">
            {screen.sections.map((s) => (
              <TypeBlock key={s.workType ?? 'all'} section={s} />
            ))}
          </div>
        </Section>

        <Section
          id="dias-fuera"
          title="Tus días fuera"
          subtitle="Vacaciones, incapacidad, un permiso: anótalos y esos días no cuentan en contra."
          icon={<CalendarOff className="h-4 w-4" aria-hidden />}
        >
          <AwayDaysEditor
            personId={person.id}
            firstName={person.firstName}
            self
            initial={person.awayDays}
            today={screen.today}
            saveAway={actions.saveAway}
          />
        </Section>

        <p className="flex items-start gap-2 text-xs leading-relaxed text-ink-muted">
          <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          Se mide trabajo registrado (casos, compromisos, filas de tablas, lo que se anota en el
          chat), nunca el contenido de tus chats o correos. No hay una nota ni un ranking. Si algo
          no está bien registrado, dilo y se corrige.
        </p>
      </div>
    </>
  );
}
