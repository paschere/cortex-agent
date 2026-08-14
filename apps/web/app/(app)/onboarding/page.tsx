import { PageHeader } from '@/components/ui/page-header';
import { IconChip, Panel, PanelHead } from '@/components/ui/panel';
import { reviewGuidedSetup } from '@/lib/guided-setup/store';
import {
  GOAL_FIRST_QUESTION,
  type OnboardingGoal,
  type OnboardingStepId,
} from '@/lib/plan-shape';
import { requireSession } from '@/lib/session';
import { chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { readOnboarding, readSeats, readWorkspacePlan } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  BookOpen,
  Check,
  HelpCircle,
  MessageSquare,
  MessagesSquare,
  Plug,
  Rocket,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { DismissGuide } from './_components/DismissGuide';
import { GoalPicker } from './_components/GoalPicker';
import { InviteTeam } from './_components/InviteTeam';

export const dynamic = 'force-dynamic';

/**
 * /onboarding — the first ten minutes of a new company, and the one screen that
 * decides whether there is an eleventh.
 *
 * WHAT IT REFUSES TO BE. Not a tour, and not a checklist of product features.
 * A new workspace's problem is not that it has not seen the menu; it is that
 * Cortex is a brain and its brain is empty, so every question it is asked comes
 * back with "no tengo nada sobre eso" — and somebody who learns that on their
 * first try has learned the wrong thing and will not try twice.
 *
 * So the whole screen is built around ONE arc: answer one question, connect the
 * source that answer implies, then ask the question that only that source can
 * answer. The invite step is deliberately last. Bringing four colleagues into a
 * workspace that cannot answer anything yet is how a pilot dies on day one, with
 * everybody having looked exactly once.
 *
 * Every "listo" on this page is read from the data, not from a stored checkbox
 * — see readOnboarding. Disconnect Google and the step goes back to pending,
 * which is the honest thing for it to do.
 */

interface StepCopy {
  title: string;
  body: string;
  icon: ReactNode;
  /** The control that completes it. `null` when the step has its own widget. */
  action: { href: string; label: string } | null;
  doneNote: string;
}

/** The source to connect, per goal. This is what the question actually buys. */
function sourceCopy(goal: OnboardingGoal | null): StepCopy {
  if (goal === 'meetings') {
    return {
      title: 'Conecta Google para traer tus reuniones',
      body: 'Cortex lee las grabaciones y transcripciones de Google Meet a las que ya tienes acceso. No toca nada más de tu cuenta que lo que autorices.',
      icon: <Plug className="h-4 w-4" />,
      action: { href: '/api/integrations/google?preset=all', label: 'Conectar Google' },
      doneNote: 'Ya hay una fuente conectada.',
    };
  }
  if (goal === 'email') {
    return {
      title: 'Conecta tu correo',
      body: 'Gmail o Outlook. Es la fuente que más rápido da respuestas útiles, porque tus conversaciones reales ya están ahí — no hay que subir nada.',
      icon: <Plug className="h-4 w-4" />,
      action: { href: '/integrations', label: 'Ver integraciones' },
      doneNote: 'Ya hay una fuente conectada.',
    };
  }
  return {
    title: 'Conecta una fuente',
    body: 'Google Workspace o Microsoft 365. Con el correo y el calendario adentro, Cortex responde sobre lo que de verdad está pasando en tu empresa.',
    icon: <Plug className="h-4 w-4" />,
    action: { href: '/integrations', label: 'Ver integraciones' },
    doneNote: 'Ya hay una fuente conectada.',
  };
}

function stepCopy(step: OnboardingStepId, goal: OnboardingGoal | null): StepCopy {
  switch (step) {
    case 'goal':
      return {
        title: '¿Qué quieres que Cortex haga primero?',
        body: 'Tu respuesta cambia el orden de lo que sigue y qué conectamos primero. La puedes cambiar cuando quieras.',
        icon: <HelpCircle className="h-4 w-4" />,
        action: null,
        doneNote: 'Listo.',
      };
    case 'source':
      return sourceCopy(goal);
    case 'knowledge':
      return {
        title: 'Trae algo que Cortex deba saber',
        body: 'Un contrato, una tarifa, un manual. Lo que subas queda citable: cuando Cortex responda desde ahí, te muestra la frase exacta de dónde lo sacó.',
        icon: <BookOpen className="h-4 w-4" />,
        action: { href: '/kb', label: 'Abrir Brain Knowledge' },
        doneNote: 'Ya hay algo adentro.',
      };
    case 'answer':
      return {
        title: 'Hazle la primera pregunta',
        body: goal
          ? `Prueba con esto: «${GOAL_FIRST_QUESTION[goal]}»`
          : 'Pregúntale algo que solo tu empresa sepa responder. Ahí es donde se nota.',
        icon: <MessageSquare className="h-4 w-4" />,
        action: { href: '/chat', label: 'Ir al chat' },
        doneNote: 'Cortex ya respondió al menos una vez.',
      };
    case 'team':
      return {
        title: 'Invita a tu equipo',
        body: 'Al final y no al principio, a propósito: que la primera vez que entren, Cortex ya sepa algo de la empresa.',
        icon: <Users className="h-4 w-4" />,
        action: null,
        doneNote: 'Ya no estás solo en el espacio.',
      };
  }
}

export default async function OnboardingPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const [state, { plan, contractedSeats }, setup] = await Promise.all([
    readOnboarding(db),
    readWorkspacePlan(db),
    reviewGuidedSetup(db).catch(() => null),
  ]);
  const seats = await readSeats(db, user.organization.id, plan, contractedSeats);

  const doneCount = state.steps.filter((s) => s.done).length;
  const firstName = (user.name ?? '').trim().split(' ')[0] || 'Hola';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Primeros pasos"
        subtitle={
          state.done
            ? 'Ya está todo listo. Esta guía se queda aquí por si entra alguien nuevo.'
            : `${firstName}, esto es lo que hace que Cortex sirva desde hoy y no dentro de un mes.`
        }
        icon={<Rocket className="h-4 w-4" />}
        actions={
          <span className={chipClass(state.done ? 'emerald' : 'primary')}>
            <span className="tabular">
              {doneCount} de {state.steps.length}
            </span>
          </span>
        }
      />

      {/* The empty-brain warning, said once and only while it is true. */}
      {!state.steps.find((s) => s.id === 'knowledge')?.done &&
        !state.steps.find((s) => s.id === 'source')?.done && (
          <Panel className="border-primary/20 bg-primary-soft/40 p-4">
            <p className="text-sm leading-relaxed text-primary-ink">
              Ahora mismo Cortex no sabe nada de{' '}
              <span className="font-semibold">{user.organization.name}</span>. No es que esté
              vacío el panel: es que todavía no le has dado de dónde responder. Los dos primeros
              pasos de abajo lo arreglan.
            </p>
          </Panel>
        )}

      <ol className="space-y-3">
        {state.steps.map((step, index) => {
          const copy = stepCopy(step.id, state.goal);
          const isNext = state.next === step.id;
          return (
            <li key={step.id}>
              <Panel
                className={clsx(
                  'overflow-hidden',
                  isNext && 'ring-1 ring-primary/25',
                  step.done && 'opacity-[0.72]',
                )}
              >
                <div className="flex gap-3.5 p-5">
                  <div className="shrink-0">
                    {step.done ? (
                      <span className="grid h-8 w-8 place-items-center rounded-sm bg-emerald-soft text-emerald">
                        <Check className="h-4 w-4" />
                      </span>
                    ) : (
                      <IconChip tone={isNext ? 'primary' : 'sky'}>{copy.icon}</IconChip>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="tabular text-micro font-semibold text-ink-faint">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <h2 className="text-base font-semibold text-ink">{copy.title}</h2>
                      {isNext && <span className={chipClass('primary')}>Sigue esto</span>}
                    </div>

                    <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                      {step.done ? copy.doneNote : copy.body}
                    </p>

                    {step.id === 'goal' && !step.done && (
                      <div className="mt-3.5">
                        <GoalPicker current={state.goal} />
                      </div>
                    )}
                    {step.id === 'goal' && step.done && state.goal && (
                      <div className="mt-3.5">
                        <GoalPicker current={state.goal} />
                      </div>
                    )}

                    {step.id === 'team' && !step.done && (
                      <div className="mt-3.5">
                        <InviteTeam
                          seatsUsed={seats.used}
                          seatsMaximum={seats.maximum}
                          perSeatAnswers={plan.perSeat.answers}
                          priceCopPerSeat={plan.priceCopPerSeat}
                          canInvite={user.role === 'org_admin'}
                        />
                      </div>
                    )}

                    {copy.action && !step.done && (
                      <Link
                        href={copy.action.href}
                        className="mt-3.5 inline-flex items-center rounded-pill bg-primary px-3.5 py-2 text-xs font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px motion-reduce:transform-none motion-reduce:transition-none"
                      >
                        {copy.action.label}
                      </Link>
                    )}
                  </div>
                </div>
              </Panel>
            </li>
          );
        })}
      </ol>

      {/*
        La entrevista, ofrecida aquí y no metida en la lista de arriba.

        Los cinco pasos responden "¿de dónde saca Cortex lo que sabe?" y su
        progreso se deriva de los datos, sin casillas guardadas. La entrevista
        responde la pregunta siguiente — "¿qué debería estar haciendo por mí?" —
        y sólo tiene sentido preguntarla cuando ya hay algo adentro. Así que
        aparece cuando la primera respuesta ya ocurrió, y después de eso deja de
        ser una invitación y pasa a ser un resultado: cuántas de las cosas que
        se configuraron hablando siguen ahí, y cuántas alguien usó.
      */}
      {setup && setup.created > 0 ? (
        <Panel>
          <PanelHead
            title="Lo que configuraste hablando"
            icon={<MessagesSquare className="h-4 w-4" />}
            right={
              <span className={chipClass(setup.used > 0 ? 'emerald' : 'neutral')}>
                <span className="tabular">
                  {setup.used} de {setup.created}
                </span>
                <span className="ml-1">en uso</span>
              </span>
            }
          />
          <div className="px-5 pb-5 pt-3">
            <p className="max-w-2xl text-xs leading-relaxed text-ink-muted">
              De las <span className="tabular font-semibold text-ink">{setup.created}</span> cosas
              que se crearon desde la entrevista,{' '}
              <span className="tabular font-semibold text-ink">{setup.alive}</span> siguen ahí y{' '}
              <span className="tabular font-semibold text-ink">{setup.used}</span> se han usado. La
              medida de que esto sirvió no es cuántas se crearon: es cuántas siguen vivas dentro de
              unas semanas.
            </p>
            <ul className="mt-3 space-y-1.5">
              {setup.rows.slice(0, 5).map((row) => (
                <li
                  key={row.item.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 text-xs"
                >
                  <span className={clsx('truncate', row.alive ? 'text-ink' : 'text-ink-faint')}>
                    {row.item.title}
                  </span>
                  <span className={clsx(row.used ? 'text-emerald' : 'text-ink-faint')}>
                    {row.evidence}
                  </span>
                </li>
              ))}
            </ul>
            <Link
              href="/onboarding/entrevista"
              className="mt-3.5 inline-block text-xs font-semibold text-primary hover:underline"
            >
              Contarle algo más
            </Link>
          </div>
        </Panel>
      ) : (
        state.steps.find((s) => s.id === 'answer')?.done && (
          <Panel className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-4 p-5">
              <div className="min-w-0 max-w-xl">
                <div className="flex items-center gap-2.5">
                  <IconChip tone="primary">
                    <MessagesSquare className="h-4 w-4" />
                  </IconChip>
                  <h2 className="text-base font-semibold text-ink">
                    Ahora dile qué debería estar haciendo por ti
                  </h2>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-ink-muted">
                  Cuéntale cómo trabajan — qué se les vence, qué revisan cada semana, qué
                  procedimiento siguen — y te propone qué dejar configurado. Nada se crea sin que
                  lo apruebes, y todo se puede deshacer.
                </p>
              </div>
              <Link
                href="/onboarding/entrevista"
                className="inline-flex shrink-0 items-center rounded-pill bg-primary px-3.5 py-2 text-xs font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px motion-reduce:transform-none motion-reduce:transition-none"
              >
                Empezar a contarle
              </Link>
            </div>
          </Panel>
        )
      )}

      <Panel>
        <PanelHead title="Tu plan mientras tanto" icon={<Rocket className="h-4 w-4" />} />
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-5 pt-3">
          <p className="max-w-xl text-xs leading-relaxed text-ink-muted">
            Estás en el plan <span className="font-semibold text-ink">{plan.name}</span>. Se mide
            por respuestas y documentos, no por tokens, y puedes ver de dónde sale cada cifra
            cuando quieras.
          </p>
          <Link
            href="/plan"
            className="text-xs font-semibold text-primary hover:underline"
          >
            Ver plan y consumo
          </Link>
        </div>
      </Panel>

      <div className="flex justify-center pb-2">
        <DismissGuide />
      </div>
    </div>
  );
}
