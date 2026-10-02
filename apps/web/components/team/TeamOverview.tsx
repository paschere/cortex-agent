import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import type { PersonCardModel, SignalCardModel, TeamScreen } from '@/lib/team/screen';
import { clsx } from 'clsx';
import {
  Award,
  CalendarOff,
  ChevronRight,
  Inbox,
  Info,
  Lightbulb,
  MessageSquareText,
  Settings2,
  ShieldCheck,
  UserRound,
  Users,
  UsersRound,
} from 'lucide-react';
import Link from 'next/link';
import { EmptyTeam } from './EmptyTeam';
import { ReassignDialog } from './ReassignDialog';
import {
  Avatar,
  ChoiceRow,
  ItemList,
  MetricGrid,
  Pill,
  type PillTone,
  Section,
  pillLink,
  pillQuiet,
} from './pieces';
import type { TeamActions } from './types';

/**
 * /team: «¿cómo va el equipo?», contestado con evidencia y sin ranking.
 *
 *   1. Lo que pide atención: las señales del motor con su evidencia y una
 *      acción a un clic (reasignar, ver los ítems, escribirle con apoyo).
 *   2. Reconocimientos: lo que mejoró o destaca, para decirlo.
 *   3. Las personas, en orden alfabético: cada cifra contra su propio período
 *      anterior y, en voz baja, la mediana del equipo en el mismo tipo.
 *   4. Lo que no tiene responsable.
 *
 * Se pinta igual en el servidor y en /v/equipo-showcase: todo llega armado en
 * `TeamScreen` (lib/team/screen.ts); las islas de cliente reciben `actions`.
 */
export function TeamOverview({
  screen,
  actions,
  connectHref,
}: {
  screen: TeamScreen;
  actions: TeamActions;
  /** La petición al chat para conectar el trabajo. */
  connectHref: string;
}) {
  const { period } = screen;
  return (
    <>
      <PageHeader
        title="Equipo"
        subtitle={`Cómo va el trabajo ${period.label.toLowerCase()} (${period.range}): lo que pide atención, lo que avanza y quién tiene qué. Se mide el trabajo, no a las personas.`}
        icon={<UsersRound className="h-5 w-5" />}
        actions={
          <>
            <Link href={screen.links.me} className={pillLink}>
              <UserRound className="h-3.5 w-3.5" aria-hidden />
              Mi semana
            </Link>
            {screen.canConfigure && (
              <Link href={screen.links.settings} className={pillLink}>
                <Settings2 className="h-3.5 w-3.5" aria-hidden />
                Qué se mide
              </Link>
            )}
            {screen.canConfigure && (
              <Link href={screen.links.people} className={pillQuiet}>
                <Users className="h-3.5 w-3.5" aria-hidden />
                Personas y accesos
              </Link>
            )}
            {screen.links.activity && (
              <Link href={screen.links.activity} className={pillQuiet}>
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                Actividad
              </Link>
            )}
          </>
        }
      />

      {screen.empty ? (
        <EmptyTeam
          canConfigure={screen.canConfigure}
          settingsHref={screen.links.settings}
          connectHref={connectHref}
        />
      ) : (
        <div className="space-y-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <ChoiceRow label="Período" choices={screen.periods} />
            {screen.types.length > 2 && (
              <ChoiceRow label="Tipo de trabajo" choices={screen.types} />
            )}
          </div>

          {screen.seesAll && (
            <Section
              id="atencion"
              title="Lo que pide atención"
              subtitle="Cada cosa con sus cifras y algo concreto que se puede hacer. Repartir o preguntar, nunca sancionar."
              icon={<Lightbulb className="h-4 w-4" aria-hidden />}
            >
              {screen.attention.length === 0 ? (
                <p className="text-sm text-ink-muted">
                  Nada pide atención en este período: nadie está sobrecargado ni hay vencidos
                  acumulados.
                </p>
              ) : (
                <ul className="space-y-3">
                  {screen.attention.map((s) => (
                    <SignalItem
                      key={s.key}
                      signal={s}
                      actions={actions}
                      canReassign={screen.canReassign}
                    />
                  ))}
                </ul>
              )}
            </Section>
          )}

          {screen.recognitions.length > 0 && (
            <Section
              id="reconocimientos"
              title="Reconocimientos"
              subtitle="Lo que mejoró contra su propia historia, o destaca en su tipo de trabajo. Vale decirlo."
              icon={<Award className="h-4 w-4" aria-hidden />}
            >
              <ul className="grid gap-3 md:grid-cols-2">
                {screen.recognitions.map((s) => (
                  <SignalItem key={s.key} signal={s} actions={actions} canReassign={false} />
                ))}
              </ul>
            </Section>
          )}

          <section aria-labelledby="personas-titulo">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="personas-titulo" className="text-lg font-extrabold text-ink">
                  Las personas
                </h2>
                <p className="text-xs text-ink-muted">
                  En orden alfabético. Las flechas comparan con su propio período anterior; «equipo»
                  es la mediana{screen.workType ? ` en ${screen.workType}` : ''}.
                </p>
              </div>
            </div>
            {screen.people.length === 0 ? (
              <Panel className="p-6 text-sm text-ink-muted">
                Nadie tiene trabajo de este tipo en el período.
              </Panel>
            ) : (
              <ul className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {screen.people.map((p) => (
                  <PersonCard key={p.id} person={p} />
                ))}
              </ul>
            )}
            {screen.withoutType.length > 0 && (
              <p className="mt-3 text-xs text-ink-muted">
                Sin trabajo de este tipo en el período: {screen.withoutType.join(', ')}.
              </p>
            )}
          </section>

          {screen.unassigned && (
            <Section
              id="sin-asignar"
              title="Sin asignar"
              subtitle="Trabajo abierto que no es de nadie: no cuenta para ninguna persona hasta que alguien lo tome."
              icon={<Inbox className="h-4 w-4" aria-hidden />}
              right={
                screen.unassigned.signal &&
                screen.canReassign &&
                screen.unassigned.signal.moves.length > 0 ? (
                  <ReassignDialog
                    moves={screen.unassigned.signal.moves}
                    blocked={screen.unassigned.signal.blocked}
                    fromName={null}
                    reassign={actions.reassign}
                  />
                ) : null
              }
            >
              {screen.unassigned.count === 0 ? (
                <p className="text-sm text-ink-muted">Todo el trabajo abierto tiene responsable.</p>
              ) : (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Pill tone="amber">
                      <span className="tabular">{screen.unassigned.count}</span> abiertos
                    </Pill>
                    {screen.unassigned.overdue > 0 && (
                      <Pill tone="rose">
                        <span className="tabular">{screen.unassigned.overdue}</span> vencidos
                      </Pill>
                    )}
                    {screen.unassigned.byType.map((t) => (
                      <Pill key={t.workType}>
                        {t.workType} <span className="tabular">{t.count}</span>
                      </Pill>
                    ))}
                  </div>
                  {screen.unassigned.signal?.suggestion && (
                    <p className="mb-2 text-xs text-ink-muted">
                      {screen.unassigned.signal.suggestion}
                    </p>
                  )}
                  <ItemList items={screen.unassigned.items} />
                  {screen.unassigned.more > 0 && (
                    <p className="mt-2 text-xs text-ink-muted">
                      Y <span className="tabular">{screen.unassigned.more}</span> más.
                    </p>
                  )}
                </>
              )}
            </Section>
          )}

          {screen.notes.length > 0 && (
            <details className="rounded-card border border-border bg-surface px-5 py-4 shadow-card">
              <summary className="flex cursor-pointer items-center gap-2 text-sm font-bold text-ink">
                <Info className="h-4 w-4 text-ink-faint" aria-hidden />
                Cómo se mide
              </summary>
              <ul className="mt-3 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-ink-muted">
                {screen.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </details>
          )}
          {screen.truncated && (
            <p className="text-xs text-ink-muted">
              Hay más trabajo del que cabe en esta foto: las cifras cuentan los primeros miles de
              ítems.
            </p>
          )}
        </div>
      )}
    </>
  );
}

const TONE_BAR: Record<SignalCardModel['tone'], string> = {
  rose: 'bg-rose',
  amber: 'bg-amber',
  sky: 'bg-sky',
  emerald: 'bg-emerald',
};

function SignalItem({
  signal,
  actions,
  canReassign,
}: {
  signal: SignalCardModel;
  actions: TeamActions;
  canReassign: boolean;
}) {
  const tone: PillTone = signal.tone;
  return (
    <li className="relative overflow-hidden rounded-sm border border-border bg-surface py-3.5 pl-5 pr-4">
      <span aria-hidden className={clsx('absolute inset-y-0 left-0 w-1', TONE_BAR[signal.tone])} />
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={tone}>{signal.title}</Pill>
        {signal.personName && signal.personHref ? (
          <Link href={signal.personHref} className="text-sm font-bold text-ink hover:underline">
            {signal.personName}
          </Link>
        ) : null}
        {signal.workType && <span className="text-xs text-ink-muted">{signal.workType}</span>}
      </div>
      <p className="mt-1.5 text-sm text-ink">{signal.message}</p>
      {signal.suggestion && (
        <p className="mt-1 flex items-start gap-1.5 text-xs text-ink-muted">
          <Lightbulb className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
          <span>{signal.suggestion}</span>
        </p>
      )}
      {signal.evidence.length > 0 && (
        <dl className="mt-2 flex flex-wrap gap-1.5">
          {signal.evidence.map((e) => (
            <div
              key={e.label}
              className="inline-flex items-baseline gap-1 rounded-pill bg-surface-2 px-2 py-0.5 text-micro text-ink-muted"
            >
              <dt>{e.label}</dt>
              <dd className="tabular font-semibold text-ink">{e.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canReassign && signal.moves.length > 0 && (
          <ReassignDialog
            moves={signal.moves}
            blocked={signal.blocked}
            fromName={signal.personName}
            reassign={actions.reassign}
          />
        )}
        {signal.writeHref && (
          <Link href={signal.writeHref} className={pillLink}>
            <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
            Escribirle
          </Link>
        )}
      </div>
      {signal.items.length > 0 && (
        <details className="group mt-2">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-pill px-2 py-1 text-xs font-semibold text-primary-ink hover:bg-primary-soft">
            <ChevronRight
              className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
              aria-hidden
            />
            <span>
              Ver ítems (<span className="tabular">{signal.items.length + signal.moreItems}</span>)
            </span>
          </summary>
          <div className="mt-1 rounded-sm bg-surface-2/50 px-3">
            <ItemList items={signal.items} showOwner={!signal.personId} />
            {signal.moreItems > 0 && signal.personHref && (
              <Link
                href={signal.personHref}
                className="block pb-3 text-xs font-semibold text-primary-ink hover:underline"
              >
                Ver los {signal.items.length + signal.moreItems} en su detalle
              </Link>
            )}
          </div>
        </details>
      )}
    </li>
  );
}

function PersonCard({ person }: { person: PersonCardModel }) {
  return (
    <li>
      <Panel className="flex h-full flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Avatar initials={person.initials} />
            <div className="min-w-0">
              <p className="truncate text-base font-bold text-ink">
                {person.href ? (
                  <Link href={person.href} className="hover:underline">
                    {person.name}
                  </Link>
                ) : (
                  person.name
                )}
              </p>
              <p className="truncate text-xs text-ink-muted">
                {[person.team, person.role].filter(Boolean).join(' · ') || 'Sin equipo asignado'}
              </p>
            </div>
          </div>
          {person.awayToday ? (
            <Pill tone="sky">
              <CalendarOff className="h-3 w-3" aria-hidden />
              Fuera hoy
            </Pill>
          ) : person.awayInPeriod > 0 ? (
            <Pill>
              <CalendarOff className="h-3 w-3" aria-hidden />
              <span className="tabular">{person.awayInPeriod}</span>{' '}
              {person.awayInPeriod === 1 ? 'día fuera' : 'días fuera'}
            </Pill>
          ) : null}
        </div>
        {person.empty ? (
          <p className="mt-4 flex-1 text-sm text-ink-muted">{person.note}</p>
        ) : (
          <>
            <div className="mt-4">
              <MetricGrid metrics={person.metrics} output={person.output} />
            </div>
            {person.note && <p className="mt-3 text-xs text-ink-muted">{person.note}</p>}
          </>
        )}
        {person.href && (
          <Link
            href={person.href}
            className="mt-3 inline-flex items-center gap-1 self-start text-xs font-semibold text-primary-ink hover:underline"
          >
            Ver detalle
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </Panel>
    </li>
  );
}
