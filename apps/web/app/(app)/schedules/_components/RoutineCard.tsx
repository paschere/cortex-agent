'use client';

import { Provenance } from '@/components/ui/provenance';
import { DOT_TONE, type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  AlarmClock,
  Bot,
  ChevronDown,
  Globe,
  Loader2,
  Mail,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  ShieldAlert,
  TriangleAlert,
  Wrench,
  X,
} from 'lucide-react';
import Link from 'next/link';
import {
  JOB_STATUS_LABEL,
  fmt,
  humanizeCron,
  relative,
  runDuration,
  stripMarkdown,
  untilNext,
} from './format';
import type { JobRun, JobStatus, ScheduledJob } from './types';

/** A routine in force is green; paused wants attention; cancelled is a red stamp. */
const STATUS_TONE: Record<JobStatus, StatusTone> = {
  active: 'emerald',
  paused: 'amber',
  completed: 'neutral',
  cancelled: 'rose',
};

const RUN_TONE: Record<JobRun['status'], StatusTone> = {
  ok: 'emerald',
  error: 'rose',
  running: 'primary',
};

const RUN_LABEL: Record<JobRun['status'], string> = {
  ok: 'exitosa',
  error: 'falló',
  running: 'corriendo',
};

const ICON_BTN =
  'rounded-card p-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50';

/** Two or more consecutive failures at the head of the history. */
function isFailing(runs: JobRun[]): boolean {
  return runs.length >= 2 && runs[0]?.status === 'error' && runs[1]?.status === 'error';
}

export function RoutineCard({
  job,
  now,
  expanded,
  busy,
  running,
  canEdit,
  highlightRunId,
  onToggle,
  onRunNow,
  onAction,
  onEdit,
  onOpenRun,
  onSelectRun,
}: {
  job: ScheduledJob;
  now: number | null;
  expanded: boolean;
  busy: boolean;
  running: boolean;
  canEdit: boolean;
  highlightRunId: string | null;
  onToggle: () => void;
  onRunNow: () => void;
  onAction: (action: 'pause' | 'resume' | 'cancel') => void;
  onEdit: () => void;
  onOpenRun: (run: JobRun) => void;
  onSelectRun: (run: JobRun) => void;
}) {
  const next = untilNext(job.nextRunAt, now);
  const lastRun = job.runs[0];
  const failing = isFailing(job.runs);
  // Errors are plain text; outputs are agent markdown — flatten them to prose.
  const preview = lastRun?.error ?? (lastRun?.output ? stripMarkdown(lastRun.output) : null);

  return (
    <section className="group overflow-hidden rounded-card border border-border bg-surface transition-colors hover:border-border-strong">
      <div className="relative flex flex-wrap items-start gap-3 p-4">
        {/*
         * Card-wide link, same trick the pipelines gallery uses: an absolutely
         * positioned overlay carries the navigation, and every control that has
         * to stay clickable is lifted above it with `relative z-10`.
         */}
        <Link
          href={`/schedules/${job.id}`}
          aria-label={`Abrir ${job.name}`}
          className="absolute inset-0 z-0 rounded-card focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        />
        <span
          className={clsx(
            'grid h-10 w-10 shrink-0 place-items-center rounded-card border',
            job.status === 'active'
              ? 'border-primary/30 bg-primary-soft text-primary'
              : 'border-border bg-surface-2 text-ink-faint',
          )}
        >
          {job.kind === 'tool' ? (
            <Wrench style={{ height: 18, width: 18 }} />
          ) : (
            <Bot style={{ height: 18, width: 18 }} />
          )}
        </span>

        <div className="min-w-0 flex-1 basis-[15rem]">
          <h3 className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-bold text-ink transition-colors group-hover:text-primary">
              {job.name}
            </span>
            <span className={chipClass(STATUS_TONE[job.status])}>
              {JOB_STATUS_LABEL[job.status]}
            </span>
            {job.isGlobal && (
              <span
                className={chipClass('primary')}
                title="Rutina del equipo: corre para todo el espacio de trabajo"
              >
                <Globe className="h-3 w-3" /> global
              </span>
            )}
            {failing && (
              <span className={chipClass('rose')} title="Las últimas ejecuciones fallaron seguidas">
                <TriangleAlert className="h-3 w-3" /> fallando
              </span>
            )}
            {job.allowUnattendedWrites && (
              <span
                className={chipClass('amber')}
                title="Esta rutina puede ejecutar herramientas de escritura sin que nadie confirme cada una"
              >
                <ShieldAlert className="h-3 w-3" /> escribe sin permiso
              </span>
            )}
            {job.notifyEmail && (
              <span
                className="inline-flex items-center gap-1 text-[10.5px] text-ink-faint"
                title="Envía el resultado por correo"
              >
                <Mail className="h-3 w-3" />
              </span>
            )}
          </h3>

          <div className="tabular mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-faint">
            <span className="inline-flex items-center gap-1 font-semibold text-ink-muted">
              <AlarmClock className="h-3.5 w-3.5 text-primary" />
              {job.scheduleKind === 'once'
                ? `Una vez, el ${fmt(job.runAt)}`
                : humanizeCron(job.cron, job.timezone)}
            </span>
            {next && job.status === 'active' && (
              <span className="rounded-sm border border-primary/30 bg-primary-soft px-1.5 font-semibold text-primary">
                próxima {next}
              </span>
            )}
            <span>última {fmt(job.lastRunAt)}</span>

            {/* Run strip — newest first, hoverable, click to jump to the run. */}
            {job.runs.length > 0 && (
              <span className="relative z-10 inline-flex items-center gap-1">
                {job.runs.slice(0, 10).map((r) => {
                  const when = relative(r.started_at, now);
                  const took = runDuration(r.started_at, r.finished_at);
                  const label = `${r.status === 'ok' ? 'Exitosa' : r.status === 'error' ? 'Falló' : 'Corriendo'}${
                    when ? ` · ${when}` : ''
                  }${took ? ` · ${took}` : ''}`;
                  return (
                    <span key={r.id} className="group/dot relative inline-flex">
                      <button
                        type="button"
                        onClick={() => onSelectRun(r)}
                        aria-label={label}
                        className={clsx(
                          'h-2.5 w-2.5 rounded-full transition-transform hover:scale-125 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary motion-reduce:transform-none',
                          DOT_TONE[RUN_TONE[r.status]],
                        )}
                      />
                      {/* Below the dot on purpose: the card clips overflow. */}
                      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-sm bg-ink px-2 py-1 text-[10.5px] font-semibold text-surface shadow-pop group-hover/dot:block group-focus-within/dot:block">
                        {label}
                      </span>
                    </span>
                  );
                })}
              </span>
            )}
          </div>

          {job.recipients.length > 0 && (
            <div
              className="mt-1 flex items-center gap-1 truncate text-[11.5px] text-ink-faint"
              title={job.recipients.join(', ')}
            >
              <Mail className="h-3 w-3 shrink-0" />
              <span className="truncate">Le escribe a {job.recipients.join(', ')}</span>
            </div>
          )}

          {/*
           * The last run, stamped. This is real provenance — the routine ran at
           * a stated moment and produced a stated outcome — so it gets the mark.
           */}
          {lastRun ? (
            <div className="mt-2">
              <Provenance
                source="Última ejecución"
                readAt={fmt(lastRun.started_at)}
                detail={
                  runDuration(lastRun.started_at, lastRun.finished_at)
                    ? `${RUN_LABEL[lastRun.status]} en ${runDuration(lastRun.started_at, lastRun.finished_at)}`
                    : RUN_LABEL[lastRun.status]
                }
                tone={lastRun.status === 'error' ? 'seal' : 'stamp'}
              />
              {preview && (
                <button
                  type="button"
                  onClick={() => onOpenRun(lastRun)}
                  title="Ver el resultado completo"
                  className="relative z-10 mt-1.5 block w-full rounded-card border border-border bg-surface-2 px-3 py-2 text-left transition-colors hover:bg-canvas focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span
                    className={clsx(
                      'line-clamp-2 text-[12px] leading-relaxed',
                      lastRun.error ? 'text-rose' : 'text-ink-muted',
                    )}
                  >
                    {preview}
                  </span>
                </button>
              )}
            </div>
          ) : (
            <p className="mt-2 text-[11.5px] text-ink-muted">
              No se ha ejecutado nunca. Dale{' '}
              <span className="font-semibold text-ink">Ejecutar ahora</span> para ver qué produce
              sin esperar a la hora programada.
            </p>
          )}
        </div>

        <div className="relative z-10 flex shrink-0 flex-wrap items-center gap-1">
          <button
            type="button"
            disabled={running || job.status !== 'active'}
            onClick={onRunNow}
            className="inline-flex items-center gap-1.5 rounded-card bg-primary px-2.5 py-1.5 text-[11.5px] font-semibold text-white transition-colors hover:bg-primary-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50"
            title={
              job.status === 'active'
                ? 'Ejecutar esta rutina ahora'
                : 'Solo se pueden ejecutar las rutinas activas'
            }
          >
            {running ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{' '}
                Ejecutando…
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" /> Ejecutar ahora
              </>
            )}
          </button>

          {canEdit && (
            <button
              type="button"
              onClick={onEdit}
              className={clsx(ICON_BTN, 'text-ink-faint hover:bg-surface-2 hover:text-ink')}
              title="Editar el nombre, la programación y los destinatarios"
              aria-label="Editar la rutina"
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}

          {job.conversationId && (
            <Link
              href={`/chat/${job.conversationId}`}
              className={clsx(ICON_BTN, 'text-ink-faint hover:bg-surface-2 hover:text-ink')}
              title="Abrir la conversación con los resultados"
            >
              <MessageSquare className="h-4 w-4" />
            </Link>
          )}

          {job.status === 'active' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction('pause')}
              className={clsx(ICON_BTN, 'text-ink-faint hover:bg-surface-2 hover:text-ink')}
              title="Pausar"
            >
              <Pause className="h-4 w-4" />
            </button>
          )}
          {job.status === 'paused' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction('resume')}
              className={clsx(ICON_BTN, 'text-emerald hover:bg-emerald-soft')}
              title="Reanudar"
            >
              <Play className="h-4 w-4" />
            </button>
          )}
          {(job.status === 'active' || job.status === 'paused') && (
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction('cancel')}
              className={clsx(ICON_BTN, 'text-rose hover:bg-rose-soft')}
              title="Cancelar para siempre"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            type="button"
            onClick={onToggle}
            className={clsx(ICON_BTN, 'text-ink-faint hover:bg-surface-2 hover:text-ink')}
            aria-label={expanded ? 'Contraer' : 'Desplegar'}
            aria-expanded={expanded}
          >
            <ChevronDown
              className={clsx('h-4 w-4 transition-transform', expanded && 'rotate-180')}
            />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-3 border-t border-border bg-canvas px-4 py-3.5">
          {(job.instruction ?? job.toolId) && (
            <div>
              <h3 className="field-label mb-1">
                {job.kind === 'agent' ? 'Instrucción' : 'Herramienta'}
              </h3>
              <p
                className={clsx(
                  'whitespace-pre-wrap rounded-card border border-border bg-surface px-3 py-2 text-[12.5px] leading-relaxed text-ink-muted',
                  job.kind === 'tool' && 'font-mono',
                )}
              >
                {job.instruction ?? job.toolId}
              </p>
            </div>
          )}
          <div>
            <h3 className="field-label mb-1.5">Ejecuciones recientes</h3>
            {job.runs.length === 0 ? (
              <p className="text-[12.5px] text-ink-muted">
                Todavía no hay ninguna ejecución. Dale{' '}
                <span className="font-semibold text-ink">Ejecutar ahora</span> y el resultado
                aparece aquí.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {job.runs.map((run) => {
                  const took = runDuration(run.started_at, run.finished_at);
                  const when = relative(run.started_at, now);
                  return (
                    <li key={run.id} id={`run-${run.id}`}>
                      <button
                        type="button"
                        onClick={() => onOpenRun(run)}
                        className={clsx(
                          'block w-full rounded-card border bg-surface px-3 py-2 text-left text-[12px] transition-colors hover:border-border-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                          highlightRunId === run.id
                            ? 'border-primary ring-2 ring-primary-soft'
                            : 'border-border',
                        )}
                      >
                        <span className="tabular flex flex-wrap items-center gap-2 text-[11px]">
                          <span className={chipClass(RUN_TONE[run.status])}>
                            {RUN_LABEL[run.status]}
                          </span>
                          <span className="text-ink-faint">{fmt(run.started_at)}</span>
                          {when && <span className="text-ink-faint">· {when}</span>}
                          {took && (
                            <span className="text-ink-faint" title="Duración de la ejecución">
                              · tomó {took}
                            </span>
                          )}
                        </span>
                        {(run.error ?? run.output) && (
                          <span
                            className={clsx(
                              'mt-1.5 line-clamp-3 block whitespace-pre-wrap text-[11.5px] leading-relaxed',
                              run.error ? 'text-rose' : 'text-ink-muted',
                            )}
                          >
                            {run.error ?? stripMarkdown(run.output ?? '')}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
