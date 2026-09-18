'use client';

import type { MissionPhaseState, MissionProgress } from '@/lib/management/mission-progress';
import { workspaceHref } from '@/lib/workspace-context';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  RefreshCw,
  SearchCheck,
} from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

const PROMPTS = [
  {
    label: 'Pendientes vencidos',
    value: 'Encuentra registros con fecha vencida y prepara asuntos para darles seguimiento.',
  },
  {
    label: 'Inventario bajo',
    value: 'Encuentra productos con inventario menor al mínimo y prepara asuntos para reponerlos.',
  },
  {
    label: 'Registros duplicados',
    value: 'Encuentra registros duplicados usando las columnas que identifican cada registro.',
  },
  {
    label: 'Elige tu propio objetivo',
    value: '',
  },
] as const;

const stateLabel: Record<MissionPhaseState, string> = {
  pending: 'Por preparar',
  ready: 'Disponible',
  review: 'Por revisar',
  verified: 'Comprobado',
  unknown: 'Por comprobar',
};

function phaseIcon(state: MissionPhaseState) {
  if (state === 'verified') return CircleCheck;
  if (state === 'review') return CircleAlert;
  if (state === 'ready') return Check;
  return CircleDashed;
}

export function MissionWorkspace({
  mission,
  today,
  workspaceId,
  isAdmin,
  truncated,
}: {
  mission: MissionProgress;
  today: string;
  userId: string;
  workspaceId: string;
  isAdmin: boolean;
  truncated: boolean;
}) {
  const [prompt, setPrompt] = useState(mission.objective ?? '');
  const [sourceId, setSourceId] = useState(mission.latestRun?.sourceId ?? '');
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const href = (path: string) => workspaceHref(workspaceId, path);
  const activationHref = (() => {
    const params = new URLSearchParams();
    if (sourceId) {
      // `source` is the current Activaciones query contract; `sourceId` keeps
      // this link forward-compatible with the workspace-aware handoff.
      params.set('source', sourceId);
      params.set('sourceId', sourceId);
    }
    if (prompt.trim()) params.set('prompt', prompt.trim());
    const query = params.toString();
    return href(`/activations${query ? `?${query}` : ''}`);
  })();
  const resumeHref = mission.resumeHref ? href(mission.resumeHref) : activationHref;

  return (
    <main className="mx-auto max-w-6xl space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-border bg-primary-soft text-primary">
            <SearchCheck className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              Primera misión acompañada
            </p>
            <h1 className="mt-2 text-2xl font-bold tracking-tight">
              Un resultado comprobable, paso a paso.
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-ink-muted">
              Elige un objetivo, consulta una fuente, simula los hallazgos y comparte sólo lo que
              puedas revisar. La misión sirve para cualquier tabla o documento; las facturas son un
              caso posible, no el recorrido completo.
            </p>
          </div>
        </div>
        <Link
          href={href('/onboarding?step=mission')}
          className="text-sm font-semibold text-primary"
        >
          Volver a puesta en marcha →
        </Link>
      </header>

      <ol className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
        {mission.phases.map((phase, index) => {
          const Icon = phaseIcon(phase.state);
          return (
            <li key={phase.id} className="min-w-0 bg-surface p-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                <Icon className="h-4 w-4 text-primary" aria-hidden />
                <span>0{index + 1}</span>
                <span>{stateLabel[phase.state]}</span>
              </div>
              <h2 className="mt-3 text-sm font-bold text-ink">{phase.label}</h2>
              <p className="mt-1 break-words text-xs leading-relaxed text-ink-muted">
                {phase.detail}
              </p>
            </li>
          );
        })}
      </ol>

      <section className="grid gap-5 rounded-xl border border-border bg-surface p-5 shadow-card md:grid-cols-[minmax(0,1.15fr)_minmax(18rem,0.85fr)] sm:p-6">
        <div className="min-w-0 space-y-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              01 · Objetivo
            </p>
            <h2 className="mt-2 text-lg font-bold">¿Qué quieres poder decidir o comprobar?</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Escribe el resultado y el siguiente paso. Cortex propondrá la regla; tú revisarás la
              evidencia antes de compartir asuntos.
            </p>
          </div>
          <div className="flex flex-wrap gap-2" aria-label="Objetivos sugeridos">
            {PROMPTS.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => {
                  setSelectedPreset(item.label);
                  setPrompt(item.value);
                }}
                aria-pressed={selectedPreset === item.label}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${selectedPreset === item.label ? 'border-primary/40 bg-primary-soft text-primary' : 'border-border text-ink-muted hover:bg-surface-2 hover:text-ink'}`}
              >
                {item.label}
              </button>
            ))}
          </div>
          <label htmlFor="mission-objective" className="block text-sm font-semibold text-ink">
            Objetivo de esta misión
            <textarea
              id="mission-objective"
              rows={4}
              maxLength={1000}
              value={prompt}
              onChange={(event) => {
                setSelectedPreset(null);
                setPrompt(event.target.value);
              }}
              placeholder="Ej.: encontrar pedidos con más de 3 días de atraso y preparar el siguiente paso para cada responsable."
              className="mt-2 w-full resize-y rounded-lg border border-border-strong bg-canvas px-3 py-2 text-sm font-normal text-ink outline-none placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          </label>
        </div>
        <div className="min-w-0 space-y-4 border-t border-border pt-5 md:border-l md:border-t-0 md:pl-5 md:pt-0">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              02 · Fuente
            </p>
            <h2 className="mt-2 text-lg font-bold">¿Dónde está el dato que lo demuestra?</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Las fuentes de Feed son privadas y temporales. La simulación guardará un snapshot
              verificable antes de crear asuntos compartidos.
            </p>
          </div>
          {mission.sources.length > 0 ? (
            <label htmlFor="mission-source" className="block text-sm font-semibold text-ink">
              Fuente de trabajo
              <select
                id="mission-source"
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                className="mt-2 min-h-10 w-full rounded-lg border border-border-strong bg-canvas px-3 text-sm font-normal text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <option value="">Que Cortex proponga una fuente</option>
                {mission.sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name} · {source.rows} filas visibles
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-sm text-ink-muted">
              Todavía no hay una fuente disponible. Añade un archivo, texto, enlace o conexión en
              Feed para continuar.
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Link href={href('/feed')} className="text-sm font-semibold text-primary">
              {mission.sources.length ? 'Añadir otra fuente' : 'Añadir una fuente'}{' '}
              <ArrowUpRight className="inline h-4 w-4" aria-hidden />
            </Link>
            {mission.latestRun && (
              <Link
                href={resumeHref}
                className="text-sm font-semibold text-ink-muted hover:text-ink"
              >
                Retomar última simulación <RefreshCw className="inline h-4 w-4" aria-hidden />
              </Link>
            )}
          </div>
          <Link
            href={activationHref}
            aria-disabled={!prompt.trim()}
            className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${prompt.trim() ? 'bg-primary text-white hover:bg-primary/90' : 'pointer-events-none bg-border text-ink-faint'}`}
          >
            {mission.latestRun ? 'Continuar en Activaciones' : 'Diseñar la simulación'}
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </section>

      {mission.latestRun && (
        <section className="grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-4 rounded-xl border border-border p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-primary">
                  03 · Simulación y resultado
                </p>
                <h2 className="mt-2 text-lg font-bold">
                  {mission.objective ?? 'Último objetivo guardado'}
                </h2>
              </div>
              <span className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-ink-muted">
                {mission.latestRun.status === 'committed' ? 'Compartida' : 'Guardada'}
              </span>
            </div>
            <p className="text-sm text-ink-muted">
              {mission.latestRun.status === 'committed'
                ? 'La simulación creó asuntos en Gerencia. Revisa cada resultado y registra evidencia de cierre.'
                : 'La simulación está guardada sólo para tu cuenta. Ábrela para revisar filas, regla y citas antes de compartirla.'}
            </p>
            {mission.cases.length > 0 ? (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {mission.cases.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-start justify-between gap-3 p-3"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm font-semibold">{item.title}</p>
                      <p className="mt-1 break-words text-xs text-ink-muted">
                        Plazo {item.dueOn} ·{' '}
                        {item.hasEvidence
                          ? 'Evidencia de cierre registrada'
                          : 'Falta evidencia de cierre'}
                      </p>
                      <p className="mt-1 break-words text-xs text-ink-muted">{item.nextAction}</p>
                    </div>
                    <Link
                      href={href(item.href)}
                      className="shrink-0 text-xs font-semibold text-primary"
                    >
                      Abrir asunto <ArrowUpRight className="inline h-3.5 w-3.5" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-ink-muted">
                Aún no hay asuntos creados a partir de esta simulación.
              </p>
            )}
          </div>
          <aside className="space-y-4 rounded-xl border border-border bg-surface-2 p-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-ink-muted">
                Resultados verificables
              </p>
              <dl className="mt-3 space-y-3">
                <Metric label="Simulaciones guardadas" value={mission.runs.simulated} />
                <Metric label="Asuntos creados" value={mission.results.created} />
                <Metric label="Por revisar" value={mission.results.readyForReview} />
                <Metric label="Cierres comprobados" value={mission.results.verified} />
              </dl>
            </div>
            <p className="text-xs leading-relaxed text-ink-muted">
              Crear un asunto demuestra que la simulación encontró una coincidencia. Sólo un cierre
              con evidencia y revisión humana cuenta como resultado comprobado.
            </p>
          </aside>
        </section>
      )}

      <div className="flex flex-wrap gap-4 text-sm font-semibold text-primary">
        <Link href={href('/management/control')}>Autonomía y calidad de datos →</Link>
        <Link href={href('/management/review')}>Resultados de la semana →</Link>
        {isAdmin && <Link href={href('/admin/usage')}>Uso disponible →</Link>}
      </div>
      {(truncated || mission.sourceCount === null) && (
        <p className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-xs text-ink-muted">
          {truncated &&
            'La lectura de asuntos está limitada; algunas cifras pueden estar incompletas. '}
          {mission.sourceCount === null &&
            'No se pudo comprobar Feed; reintenta antes de decidir que no hay fuentes.'}
        </p>
      )}
      {mission.errors.length > 0 && (
        <div
          role="alert"
          className="rounded-lg border border-amber/30 bg-amber/5 p-3 text-xs text-ink-muted"
        >
          <p className="font-semibold text-ink">Lecturas pendientes de comprobación</p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {mission.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-ink-faint">
        Consulta de misión: {today} · La evidencia conserva la empresa y la persona que autorizaron
        la simulación.
      </p>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="font-semibold tabular-nums text-ink">{value.toLocaleString('es-CO')}</dd>
    </div>
  );
}
