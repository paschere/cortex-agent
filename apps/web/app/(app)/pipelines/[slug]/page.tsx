import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { requireSession } from '@/lib/session';
import { chipClass } from '@/lib/status-chip';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  Archive,
  ArrowLeft,
  CheckCircle2,
  CircleDashed,
  Hash,
  Play,
  UserCheck,
  Wrench,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PipelineHeaderActions } from '../_components/PipelineHeaderActions';
import { RunItPanel } from '../_components/RunItPanel';
import type { ParamDef, StepDef } from '../_lib/playbook';

interface RunRow {
  id: string;
  status: string;
  summary: string | null;
  args: Record<string, string>;
  started_at: string;
  users: { name: string | null; email: string }[] | { name: string | null; email: string } | null;
}

export const dynamic = 'force-dynamic';

export default async function PipelineDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requireSession();
  const { slug } = await params;
  const sb = getSupabaseServiceClient();

  const { data: p } = await sb
    .from('pipelines')
    .select(
      'id, slug, name, description, emoji, intro, steps, params, times_run, last_run_at, created_at, archived',
    )
    .eq('slug', slug)
    .maybeSingle();
  if (!p) notFound();

  const { data: runsData } = await sb
    .from('pipeline_runs')
    .select('id, status, summary, args, started_at, users(name, email)')
    .eq('pipeline_id', p.id as string)
    .order('started_at', { ascending: false })
    .limit(10);

  const steps = (p.steps ?? []) as StepDef[];
  const pipelineParams = (p.params ?? []) as ParamDef[];
  const runs = (runsData ?? []) as unknown as RunRow[];

  const archived = Boolean(p.archived);

  return (
    <>
      <div className="mb-4">
        <Link
          href="/pipelines"
          className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-faint hover:text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Pipelines
        </Link>
      </div>

      {/* Header */}
      <div className="rule-double mb-6 flex flex-wrap items-start gap-4 pt-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-card border border-border bg-surface-2 text-[26px]">
          {(p.emoji as string) || '⚡'}
        </span>
        <div className="min-w-0 flex-1 basis-[18rem]">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-extrabold tracking-tight text-ink">
            {p.name as string}
            {archived && (
              <span className={`${chipClass('neutral')} gap-1`}>
                <Archive className="h-3 w-3" /> Archivado
              </span>
            )}
          </h1>
          <p className="mt-0.5 text-[13px] text-ink-muted">
            {(p.description as string) ||
              'Sin descripción todavía. Agrégale una la próxima vez que lo edites.'}
          </p>
          <div className="tabular mt-2 flex flex-wrap items-center gap-3 text-[11px] text-ink-faint">
            <span>{p.slug as string}</span>
            <span className="inline-flex items-center gap-1">
              <Play className="h-3.5 w-3.5" /> {p.times_run as number} ejecuciones
            </span>
            {p.last_run_at ? <span>última {relativeTime(p.last_run_at as string)}</span> : null}
          </div>
        </div>
        <PipelineHeaderActions slug={p.slug as string} archived={archived} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* The flow: numbered steps, amber nodes where a person has to decide. */}
        <Panel className="p-5">
          <div className="field-label mb-4">El flujo</div>
          {(p.intro as string) && (
            <p className="mb-5 rounded-card border border-border bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-ink-muted">
              {p.intro as string}
            </p>
          )}
          {steps.length === 0 ? (
            <p className="text-[13px] text-ink-muted">
              Este pipeline es de la versión vieja: una instrucción libre, sin pasos.{' '}
              <Link
                href={`/pipelines/${p.slug as string}/edit`}
                className="font-semibold text-primary hover:text-primary-strong"
              >
                Vuélvelo a armar con pasos
              </Link>{' '}
              para poder ver el flujo aquí.
            </p>
          ) : (
            <ol className="relative space-y-0">
              {steps.map((s, i) => {
                const isLast = i === steps.length - 1;
                return (
                  <li key={`${s.title}-${i}`} className="relative flex gap-4 pb-6">
                    {/* connector */}
                    {!isLast && (
                      <span className="absolute left-[17px] top-9 h-[calc(100%-2rem)] w-[2px] rounded bg-border" />
                    )}
                    {/* node */}
                    {s.checkpoint ? (
                      <span className="z-10 grid h-9 w-9 shrink-0 place-items-center rounded-card border border-amber bg-amber-soft">
                        <UserCheck className="h-4 w-4 text-amber" />
                      </span>
                    ) : (
                      <span className="stat-num z-10 grid h-9 w-9 shrink-0 place-items-center rounded-card bg-primary text-[13px] text-white">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                    )}
                    <div className="min-w-0 flex-1 pt-1">
                      {s.checkpoint && (
                        <div className="field-label mb-0.5 text-amber">
                          Punto de control · decides tú
                        </div>
                      )}
                      <div className="text-[13.5px] font-bold text-ink">{s.title}</div>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
                        {s.detail}
                      </p>
                      {(s.tools ?? []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(s.tools ?? []).map((t) => (
                            <span
                              key={t}
                              className="inline-flex items-center gap-1 rounded-sm border border-primary/30 bg-primary-soft px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary"
                            >
                              <Wrench className="h-3 w-3" />
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </Panel>

        <div className="space-y-4">
          {/* How to run */}
          <RunItPanel slug={p.slug as string} params={pipelineParams} />

          {/* Params */}
          {pipelineParams.length > 0 && (
            <Panel className="p-4">
              <div className="field-label mb-2.5">Parámetros</div>
              <ul className="space-y-2">
                {pipelineParams.map((param) => (
                  <li key={param.name} className="text-[12.5px]">
                    <span className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-ink">
                      <Hash className="h-3 w-3 text-primary" />
                      {param.name}
                      {param.required !== false && <span className="text-rose">*</span>}
                    </span>
                    {param.description && (
                      <p className="mt-1 pl-1 text-[11.5px] text-ink-faint">{param.description}</p>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {/* Run history */}
          <Panel className="p-4">
            <div className="field-label mb-2.5">Ejecuciones recientes</div>
            {runs.length === 0 ? (
              <p className="text-[12px] leading-relaxed text-ink-muted">
                Nadie lo ha ejecutado. Copia la frase de arriba y dísela a Cortex: la ejecución y
                quién la lanzó aparecen aquí.
              </p>
            ) : (
              <ul className="space-y-3">
                {runs.map((r) => {
                  const u = Array.isArray(r.users) ? r.users[0] : r.users;
                  return (
                    <li key={r.id} className="flex items-start gap-2.5">
                      {r.status === 'completed' ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald" />
                      ) : r.status === 'abandoned' ? (
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose" />
                      ) : (
                        <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-[12px] font-semibold text-ink">
                          {u?.name || u?.email || 'Desconocido'}{' '}
                          <span className="tabular font-normal text-ink-faint">
                            · {relativeTime(r.started_at)}
                          </span>
                        </div>
                        {r.summary && (
                          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-muted">
                            {r.summary}
                          </p>
                        )}
                        {Object.keys(r.args ?? {}).length > 0 && (
                          <p className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint">
                            {Object.entries(r.args)
                              .map(([k, v]) => `${k}=${v}`)
                              .join(' · ')}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
