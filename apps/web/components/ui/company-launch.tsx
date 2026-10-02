'use client';
import { ProfileEditor } from '@/app/(app)/management/ProfileEditor';
import type { SetupCheck } from '@/lib/management/diagnostics';
import { type LaunchStep, launchProgress } from '@/lib/management/launch-plan';
import type { MissionProgress } from '@/lib/management/mission-progress';
import type { ManagementProfile } from '@/lib/management/shape';
import { workspaceHref } from '@/lib/workspace-context';
import { clsx } from 'clsx';
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleHelp,
  MessageSquareText,
  Mic,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { MissionLaunch } from './mission-launch';
import { SourceDiagnostics } from './source-diagnostics';

/**
 * PUESTA EN MARCHA, SIN ENREDO.
 *
 * Antes era un centro de mando de doce etapas en cuatro grupos, con navegación
 * lateral, selector móvil, medidor, diagnósticos y tres pies de página: todo a
 * la vez y con el mismo peso. Quien llegaba no sabía qué hacer primero.
 *
 * Ahora la pantalla dice UNA cosa arriba —lo siguiente, con un botón— y debajo
 * una lista corta: lo esencial y, aparte, lo que depende de tu operación. Cada
 * fila muestra su estado y su botón; el detalle (qué revisar, otras formas de
 * hacerlo) se despliega sólo si se pide. Los datos y las reglas no cambiaron:
 * los pasos y su estado siguen saliendo de `buildLaunchPlan`, que lee los
 * datos reales y no los clics.
 *
 * Cada paso ofrece además hacerlo HABLANDO con Cortex: la misma petición
 * escrita en el chat, para quien prefiere contarlo a llenar una pantalla.
 */

type Person = { id: string; name: string | null; email: string };

/** Lo que se le pide a Cortex si se prefiere hacer el paso conversando. */
const STEP_PROMPTS: Record<string, string> = {
  company:
    'Te voy a contar qué hace mi empresa (productos, clientes, cómo operamos) para que lo guardes en la ficha de la empresa: ',
  scope:
    'Ayúdame a definir tu encargo: qué quiero que gestiones, qué queda fuera, qué es prioritario y cómo sabremos que funcionó.',
  context:
    'Quiero traerte la información de la empresa. Pregúntame dónde la tengo y ayúdame a conectar la primera fuente.',
  owner:
    'Ayúdame a definir a quién le escalas cuando algo se traba y quién del equipo debería participar.',
  goals: 'Ayúdame a crear una meta medible para la empresa, con su fuente, objetivo y período.',
  manual:
    'Te voy a contar paso a paso cómo hacemos un proceso de la empresa para que lo aprendas: ',
  browser: 'Quiero que hagas un trámite en una página web por mí. Ayúdame a prepararlo.',
  authority: 'Explícame qué puedes hacer sin preguntarme y ayúdame a decidir qué permisos darte.',
  routine:
    'Ayúdame a definir qué seguimientos quieres hacer solo y cada cuánto (por ejemplo, un resumen cada mañana).',
};

export function CompanyLaunch({
  name,
  workspaceId,
  diagnostics = [],
  steps,
  isAdmin,
  initialStep,
  profile,
  people,
  readAt,
  mission,
}: {
  name: string;
  workspaceId: string;
  diagnostics?: SetupCheck[];
  steps: LaunchStep[];
  isAdmin: boolean;
  initialStep?: string;
  profile: ManagementProfile | null;
  people: Person[];
  readAt: string;
  mission: MissionProgress;
}) {
  const progress = launchProgress(steps);
  const nextStep = steps.find((s) => s.id === progress.next) ?? null;
  const [open, setOpen] = useState<string | null>(
    steps.some((s) => s.id === initialStep) ? (initialStep ?? null) : null,
  );
  const [refreshing, refresh] = useTransition();
  const router = useRouter();
  const href = (h: string) => (h.startsWith('/') ? workspaceHref(workspaceId, h) : h);
  const chatHref = (id: string) =>
    STEP_PROMPTS[id] ? href(`/chat?prompt=${encodeURIComponent(STEP_PROMPTS[id])}`) : null;

  const essentials = steps.filter((s) => s.required);
  const optional = steps.filter((s) => !s.required);
  const blockedSources = diagnostics.filter((c) => c.state === 'blocked').length;
  const percent = progress.total ? Math.round((progress.ready / progress.total) * 100) : 0;

  const toggle = (id: string) => {
    const next = open === id ? null : id;
    setOpen(next);
    window.history.replaceState(
      null,
      '',
      href(next ? `/onboarding?step=${encodeURIComponent(next)}` : '/onboarding'),
    );
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 pb-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-ink-faint">{name}</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink sm:text-3xl">
            Puesta en marcha
          </h1>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-ink-muted">
            {progress.complete
              ? 'Lo esencial está listo. Lo de abajo sirve para que Cortex haga más.'
              : `Te faltan ${progress.total - progress.ready} cosas para que Cortex trabaje solo. Ve una a la vez; puedes volver cuando quieras.`}
          </p>
        </div>
        <button
          type="button"
          disabled={refreshing}
          onClick={() => refresh(() => router.refresh())}
          className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3.5 py-2 text-xs font-bold text-ink-muted transition-colors hover:text-ink disabled:opacity-60"
        >
          <RefreshCw className={clsx('h-3.5 w-3.5', refreshing && 'animate-spin')} aria-hidden />
          {refreshing ? 'Revisando…' : 'Ya lo hice, revisar'}
        </button>
      </header>

      <div className="flex items-center gap-3">
        <div className="h-2.5 flex-1 overflow-hidden rounded-pill bg-surface-2" aria-hidden>
          <div
            className="h-full rounded-pill bg-primary transition-[width] duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="tabular shrink-0 text-sm font-bold text-ink">
          {progress.ready} de {progress.total}
        </span>
      </div>

      {/* LO SIGUIENTE: una tarjeta, un botón. */}
      {nextStep && !progress.complete && (
        <section
          aria-labelledby="next-step"
          className="flex flex-col gap-4 rounded-card border-2 border-primary bg-surface p-5 shadow-pop sm:p-6"
        >
          <p className="text-xs font-bold uppercase tracking-wider text-primary">Lo siguiente</p>
          <div>
            <h2 id="next-step" className="text-xl font-extrabold tracking-tight text-ink">
              {nextStep.title}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-ink-muted">{nextStep.description}</p>
          </div>
          {nextStep.adminOnly && !isAdmin ? (
            <AdminOnlyNote />
          ) : nextStep.id === 'scope' || nextStep.id === 'mission' ? (
            <button
              type="button"
              onClick={() => toggle(nextStep.id)}
              className="cortex-primary-button inline-flex items-center gap-1.5 self-start rounded-pill bg-primary px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-strong"
            >
              Empezar aquí <ArrowRight className="h-4 w-4" aria-hidden />
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href={href(nextStep.action.href)}
                className="cortex-primary-button inline-flex items-center gap-1.5 rounded-pill bg-primary px-5 py-2.5 text-sm font-bold text-white hover:bg-primary-strong"
              >
                {nextStep.action.label} <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
              {chatHref(nextStep.id) && (
                <Link
                  href={chatHref(nextStep.id) as string}
                  className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-2.5 text-sm font-bold text-ink hover:bg-surface-2"
                >
                  <MessageSquareText className="h-4 w-4 text-primary" aria-hidden />
                  Hacerlo hablando con Cortex
                </Link>
              )}
            </div>
          )}
        </section>
      )}

      <StepList
        title="Lo esencial"
        steps={essentials}
        allSteps={steps}
        open={open}
        onToggle={toggle}
        isAdmin={isAdmin}
        href={href}
        chatHref={chatHref}
        renderInline={(step) =>
          step.id === 'scope' ? (
            profile ? (
              <ProfileEditor
                key={profile.revision}
                profile={profile}
                people={people}
                isAdmin={isAdmin}
                onSaved={() => router.refresh()}
                onManageProcesses={() => toggle('manual')}
              />
            ) : (
              <p className="text-sm text-ink-muted">
                No se pudo cargar el encargo. Pulsa «Ya lo hice, revisar» para reintentar.
              </p>
            )
          ) : step.id === 'mission' ? (
            <MissionLaunch mission={mission} workspaceId={workspaceId} />
          ) : null
        }
      />

      <StepList
        title="Cuando lo necesites"
        subtitle="Dependen de tu operación; no bloquean lo esencial."
        steps={optional}
        allSteps={steps}
        open={open}
        onToggle={toggle}
        isAdmin={isAdmin}
        href={href}
        chatHref={chatHref}
        renderInline={() => null}
      />

      {/* Las fuentes conectadas, sólo con su propio título y plegadas salvo
          que alguna esté fallando: un diagnóstico verde no pide atención. */}
      {diagnostics.length > 0 && (
        <details
          className="group rounded-card border border-border bg-surface shadow-card"
          open={blockedSources > 0}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
            <span className="flex items-center gap-2 text-sm font-bold text-ink">
              Estado de tus fuentes
              {blockedSources > 0 ? (
                <span className="rounded-pill bg-rose-soft px-2 py-0.5 text-micro font-bold text-rose">
                  {blockedSources} con problema
                </span>
              ) : (
                <span className="rounded-pill bg-emerald-soft px-2 py-0.5 text-micro font-bold text-emerald">
                  Todo bien
                </span>
              )}
            </span>
            <ChevronDown
              className="h-4 w-4 text-ink-faint transition-transform group-open:rotate-180"
              aria-hidden
            />
          </summary>
          <div className="border-t border-border px-2 pb-2 pt-1 sm:px-3">
            <SourceDiagnostics
              checks={diagnostics}
              workspaceId={workspaceId}
              workspaceName={name}
            />
          </div>
        </details>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-xs text-ink-faint">
        <div className="flex flex-wrap gap-4 font-semibold">
          <Link
            href={href('/onboarding/entrevista')}
            className="inline-flex items-center gap-1.5 text-primary hover:text-primary-strong"
          >
            <Mic className="h-3.5 w-3.5" aria-hidden /> Prefiero contarlo hablando
          </Link>
          <Link href={href('/onboarding/fuentes')} className="text-ink-muted hover:text-ink">
            Primeros 10 minutos
          </Link>
          <Link href={href('/management')} className="text-ink-muted hover:text-ink">
            Ir a mi agenda
          </Link>
        </div>
        <span>
          Revisado a las{' '}
          <time dateTime={readAt}>
            {new Intl.DateTimeFormat('es-CO', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'America/Bogota',
            }).format(new Date(readAt))}
          </time>
        </span>
      </footer>
    </div>
  );
}

function StepList({
  title,
  subtitle,
  steps,
  allSteps,
  open,
  onToggle,
  isAdmin,
  href,
  chatHref,
  renderInline,
}: {
  title: string;
  subtitle?: string;
  steps: LaunchStep[];
  allSteps: LaunchStep[];
  open: string | null;
  onToggle: (id: string) => void;
  isAdmin: boolean;
  href: (h: string) => string;
  chatHref: (id: string) => string | null;
  renderInline: (step: LaunchStep) => React.ReactNode;
}) {
  if (steps.length === 0) return null;
  return (
    <section className="flex flex-col gap-2.5">
      <div>
        <h2 className="text-base font-extrabold tracking-tight text-ink">{title}</h2>
        {subtitle && <p className="text-xs text-ink-faint">{subtitle}</p>}
      </div>
      <ol className="flex flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card">
        {steps.map((step) => {
          const isOpen = open === step.id;
          const blocked = step.adminOnly && !isAdmin;
          const inline = isOpen ? renderInline(step) : null;
          return (
            <li key={step.id} className="border-b border-border last:border-b-0">
              <div className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                <StateIcon state={step.state} n={allSteps.indexOf(step) + 1} />
                <button
                  type="button"
                  onClick={() => onToggle(step.id)}
                  aria-expanded={isOpen}
                  className="min-w-0 flex-1 text-left"
                >
                  <span
                    className={clsx(
                      'block text-sm font-bold',
                      step.state === 'ready' ? 'text-ink-muted' : 'text-ink',
                    )}
                  >
                    {step.title}
                  </span>
                  <span className="block truncate text-xs text-ink-faint">{step.evidence}</span>
                </button>
                {step.state !== 'ready' &&
                  !blocked &&
                  step.id !== 'scope' &&
                  step.id !== 'mission' && (
                    <Link
                      href={href(step.action.href)}
                      className="hidden shrink-0 rounded-pill border border-border-strong px-3 py-1.5 text-xs font-bold text-ink hover:bg-surface-2 sm:inline-flex"
                    >
                      Hacerlo
                    </Link>
                  )}
                <button
                  type="button"
                  onClick={() => onToggle(step.id)}
                  aria-label={isOpen ? `Cerrar ${step.title}` : `Ver ${step.title}`}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-faint hover:bg-surface-2 hover:text-ink"
                >
                  <ChevronDown
                    className={clsx('h-4 w-4 transition-transform', isOpen && 'rotate-180')}
                    aria-hidden
                  />
                </button>
              </div>

              {isOpen && (
                <div className="flex flex-col gap-4 border-t border-border bg-surface-2/40 px-4 py-4 sm:px-5">
                  <p className="text-sm leading-relaxed text-ink-muted">{step.description}</p>
                  {blocked && <AdminOnlyNote />}
                  {inline ?? (
                    <>
                      <ul className="flex flex-col gap-1.5 text-sm text-ink">
                        {step.checklist.map((item) => (
                          <li key={item} className="flex gap-2">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                            {item}
                          </li>
                        ))}
                      </ul>
                      {!blocked && (
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={href(step.action.href)}
                            className="cortex-primary-button inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-xs font-bold text-white hover:bg-primary-strong"
                          >
                            {step.action.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                          </Link>
                          {chatHref(step.id) && (
                            <Link
                              href={chatHref(step.id) as string}
                              className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3.5 py-2 text-xs font-bold text-ink hover:bg-surface-2"
                            >
                              <MessageSquareText className="h-3.5 w-3.5 text-primary" aria-hidden />
                              Hablando con Cortex
                            </Link>
                          )}
                          {step.alternatives
                            .filter((a) => isAdmin || !a.href.startsWith('/admin'))
                            .map((a) => (
                              <Link
                                key={a.href}
                                href={href(a.href)}
                                className="px-2 py-2 text-xs font-semibold text-ink-muted hover:text-primary"
                              >
                                {a.label}
                              </Link>
                            ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function StateIcon({ state, n }: { state: LaunchStep['state']; n: number }) {
  if (state === 'ready') {
    return (
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-emerald text-white">
        <Check className="h-4 w-4" strokeWidth={3} aria-label="Listo" />
      </span>
    );
  }
  if (state === 'unknown') {
    return (
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-amber-soft text-amber">
        <CircleHelp className="h-4 w-4" aria-label="No se pudo comprobar" />
      </span>
    );
  }
  return (
    <span className="tabular grid h-7 w-7 shrink-0 place-items-center rounded-full border-2 border-border-strong text-xs font-extrabold text-ink-faint">
      {n}
    </span>
  );
}

function AdminOnlyNote() {
  return (
    <p className="flex items-start gap-2 rounded-card bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-ink-muted">
      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
      Esto lo prepara un administrador de la empresa. Mientras tanto puedes seguir con lo demás.
    </p>
  );
}
