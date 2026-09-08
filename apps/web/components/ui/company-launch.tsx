'use client';
import { ProfileEditor } from '@/app/(app)/management/ProfileEditor';
import type { SetupCheck } from '@/lib/management/diagnostics';
import { LAUNCH_GROUPS, type LaunchStep, launchProgress } from '@/lib/management/launch-plan';
import type { ManagementProfile } from '@/lib/management/shape';
import { workspaceHref } from '@/lib/workspace-context';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleHelp,
  Mic,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { CortexSignature } from './cortex-signature';
import { SourceDiagnostics } from './source-diagnostics';
type Person = { id: string; name: string | null; email: string };
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
}) {
  const progress = launchProgress(steps);
  const [selected, setSelected] = useState(
    steps.some((s) => s.id === initialStep) ? initialStep : progress.next,
  );
  const [refreshing, refresh] = useTransition();
  const router = useRouter();
  const step = steps.find((s) => s.id === selected) ?? steps[0];
  if (!step) return null;
  const select = (id: string) => {
    setSelected(id);
    window.history.replaceState(
      null,
      '',
      workspaceHref(workspaceId, `/onboarding?step=${encodeURIComponent(id)}`),
    );
  };
  const next = steps[steps.indexOf(step) + 1];
  const status = (item: LaunchStep) =>
    item.state === 'ready'
      ? 'Base disponible'
      : item.state === 'unknown'
        ? 'Por comprobar'
        : 'Por preparar';
  return (
    <div className="launch-center">
      <header className="launch-center__header">
        <div className="launch-center__identity">
          <CortexSignature className="h-10 w-10 text-primary" />
          <div>
            <p>{name}</p>
            <h1>Puesta en marcha</h1>
          </div>
        </div>
        <div className="launch-center__header-actions">
          <button
            type="button"
            disabled={refreshing}
            onClick={() => refresh(() => router.refresh())}
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Comprobando…' : 'Comprobar progreso'}
          </button>
          <Link href="/management">
            Ir a mi agenda <ArrowUpRight size={16} />
          </Link>
        </div>
      </header>
      <div className="launch-center__summary">
        <div>
          <h2>
            {progress.complete
              ? 'Las bases están listas. Sigamos mejorándolas.'
              : 'De conocer tu empresa a resolver el primer encargo.'}
          </h2>
          <p>
            Esta configuración siempre estará aquí. Puedes recorrerla a tu ritmo, volver a un paso o
            continuar con el trabajo diario.
          </p>
        </div>
        <div className="launch-center__meter">
          <span>
            <strong>{progress.ready}</strong> / {progress.total} bases
          </span>
          <progress
            max={progress.total}
            value={progress.ready}
            aria-label="Bases de configuración disponibles"
          />
          <small>
            {progress.unknown
              ? `${progress.unknown} etapas requieren comprobar sus datos`
              : 'El progreso se lee de tus datos, no de los clics'}
          </small>
        </div>
      </div>
      <SourceDiagnostics checks={diagnostics} workspaceId={workspaceId} workspaceName={name} />
      <div className="launch-center__workspace">
        <div className="launch-center__mobile-nav">
          <label htmlFor="launch-stage">Etapa de configuración</label>
          <select
            id="launch-stage"
            value={step.id}
            onChange={(event) => select(event.target.value)}
          >
            {LAUNCH_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {steps
                  .filter((item) => item.group === group)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {steps.indexOf(item) + 1}. {item.title} — {status(item)}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
        <nav className="launch-center__nav" aria-label="Etapas de puesta en marcha">
          {LAUNCH_GROUPS.map((group) => (
            <div key={group}>
              <h3>{group}</h3>
              {steps
                .filter((s) => s.group === group)
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => select(item.id)}
                    aria-current={item.id === step.id ? 'step' : undefined}
                    data-state={item.state}
                  >
                    <span className="launch-center__step-icon">
                      {item.state === 'ready' ? (
                        <Check size={15} />
                      ) : item.state === 'unknown' ? (
                        <CircleHelp size={15} />
                      ) : (
                        steps.indexOf(item) + 1
                      )}
                    </span>
                    <span>
                      {item.title}
                      {!item.required && <small>Según tu operación</small>}
                    </span>
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <div className="launch-center__detail">
          <div className="launch-center__step-heading">
            <span>{step.group}</span>
            <span data-state={step.state}>{status(step)}</span>
          </div>
          <h2>{step.title}</h2>
          <p className="launch-center__description">{step.description}</p>
          <div className="launch-center__evidence" data-state={step.state}>
            <CircleHelp size={17} />
            <p>{step.evidence}</p>
          </div>
          {step.adminOnly && !isAdmin && (
            <p className="launch-center__permission">
              <ShieldCheck size={17} /> Un administrador prepara esta etapa. Puedes consultar el
              recorrido y continuar con tus propios datos y procesos.
            </p>
          )}
          <div hidden={step.id !== 'scope'}>
            {profile ? (
              <ProfileEditor
                key={profile.revision}
                profile={profile}
                people={people}
                isAdmin={isAdmin}
                onSaved={() => router.refresh()}
                onManageProcesses={() => select('manual')}
              />
            ) : (
              <p className="text-sm text-ink-muted">
                No se pudo cargar el encargo. Comprueba el progreso para reintentar.
              </p>
            )}
          </div>
          {step.id !== 'scope' && (
            <>
              <h3 className="launch-center__check-title">Qué revisar en esta etapa</h3>
              <ol className="launch-center__checklist">
                {step.checklist.map((item, i) => (
                  <li key={item}>
                    <span>{i + 1}</span>
                    {item}
                  </li>
                ))}
              </ol>
              <div className="launch-center__actions">
                {(!step.adminOnly || isAdmin) && (
                  <Link className="launch-center__primary" href={step.action.href}>
                    {step.action.label}
                    <ArrowUpRight size={17} />
                  </Link>
                )}
                {step.alternatives
                  .filter((a) => isAdmin || !a.href.startsWith('/admin'))
                  .map((a) => (
                    <Link key={a.href} href={a.href}>
                      {a.label}
                      <ArrowUpRight size={15} />
                    </Link>
                  ))}
              </div>
            </>
          )}
          <div className="launch-center__next">
            <p>
              {step.required
                ? 'Esta base forma parte de la puesta en marcha.'
                : 'Esta etapa depende de tu operación y no bloquea las bases.'}
              <br />
              Abrir una pantalla no marca la etapa como terminada.
            </p>
            {next && (
              <button type="button" onClick={() => select(next.id)}>
                Siguiente etapa
                <ArrowRight size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap gap-5 text-sm font-semibold text-primary">
        <Link href="/management/mission">Primera misión →</Link>
        <Link href="/management/control">Autonomía y calidad →</Link>
        <Link href="/management/review">Revisión semanal →</Link>
      </div>
      <footer className="launch-center__footer">
        <Link href="/onboarding/entrevista">
          <Mic size={17} /> Prefiero contar cómo trabajamos
        </Link>
        <span>
          Comprobado{' '}
          <time dateTime={readAt}>
            {new Intl.DateTimeFormat('es-CO', {
              hour: '2-digit',
              minute: '2-digit',
              timeZone: 'America/Bogota',
            }).format(new Date(readAt))}
          </time>{' '}
          · Bogotá
        </span>
      </footer>
    </div>
  );
}
