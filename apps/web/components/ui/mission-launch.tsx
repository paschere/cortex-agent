'use client';

import type { MissionProgress } from '@/lib/management/mission-progress';
import { workspaceHref } from '@/lib/workspace-context';
import { ArrowRight, ArrowUpRight, Check, CircleAlert, CircleDashed } from 'lucide-react';
import Link from 'next/link';

const status: Record<MissionProgress['phases'][number]['state'], string> = {
  pending: 'Por preparar',
  ready: 'Disponible',
  review: 'Por revisar',
  verified: 'Comprobado',
  unknown: 'Por comprobar',
};

function StatusIcon({ state }: { state: MissionProgress['phases'][number]['state'] }) {
  if (state === 'verified') return <Check className="h-4 w-4 text-emerald" aria-hidden />;
  if (state === 'review') return <CircleAlert className="h-4 w-4 text-amber" aria-hidden />;
  if (state === 'ready') return <Check className="h-4 w-4 text-primary" aria-hidden />;
  return <CircleDashed className="h-4 w-4 text-ink-faint" aria-hidden />;
}

export function MissionLaunch({
  mission,
  workspaceId,
}: {
  mission: MissionProgress;
  workspaceId: string;
}) {
  const href = (path: string) => workspaceHref(workspaceId, path);
  const next = mission.phases.find(
    (phase) => !['ready', 'review', 'verified'].includes(phase.state),
  );
  const destination = mission.resumeHref ?? '/management/mission';
  return (
    <section
      className="space-y-4 rounded-xl border border-primary/20 bg-primary-soft/30 p-4 sm:p-5"
      aria-label="Primera misión"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            Primera misión
          </p>
          <h3 className="mt-1 text-base font-bold text-ink">
            {mission.objective ?? 'Lleva un objetivo real hasta un primer resultado revisable.'}
          </h3>
          <p className="mt-1 text-sm text-ink-muted">
            Objetivo → fuente → simulación → resultado con evidencia. El progreso se comprueba con
            datos guardados, no con pasos visitados.
          </p>
        </div>
        <Link
          href={href(destination)}
          className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-primary"
        >
          {mission.resumeHref ? 'Retomar' : 'Preparar'}{' '}
          <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
      <ol className="grid gap-2 sm:grid-cols-4">
        {mission.phases.map((phase) => (
          <li key={phase.id} className="min-w-0 rounded-lg border border-border bg-surface p-3">
            <div className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
              <StatusIcon state={phase.state} />
              <span className="truncate">{phase.label}</span>
            </div>
            <p className="mt-1 text-xs text-ink-faint">{status[phase.state]}</p>
          </li>
        ))}
      </ol>
      {mission.errors.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-xs text-ink-muted"
        >
          <p className="font-semibold text-ink">Algunas cifras necesitan comprobación</p>
          <p className="mt-1">{mission.errors[0]}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-primary/15 pt-3 text-xs text-ink-muted">
        <span>
          {mission.results.created > 0
            ? `${mission.results.created} asunto${mission.results.created === 1 ? '' : 's'} creado${mission.results.created === 1 ? '' : 's'} · ${mission.results.verified} comprobado${mission.results.verified === 1 ? '' : 's'}`
            : next?.id === 'source'
              ? 'Añade una fuente de trabajo para continuar.'
              : 'Todavía no hay resultados creados.'}
        </span>
        {next?.id === 'source' && (
          <Link
            href={href('/feed')}
            className="inline-flex items-center gap-1 font-semibold text-primary"
          >
            Añadir fuente <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </section>
  );
}
