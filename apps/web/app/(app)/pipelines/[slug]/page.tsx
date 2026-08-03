import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Archive, Hash, Play, UserCheck, Wrench, CheckCircle2, XCircle, CircleDashed } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
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
      <div className="mb-6 flex items-start gap-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-[16px] bg-gradient-to-br from-primary to-primary-strong text-[26px] shadow-pop">
          {(p.emoji as string) || '⚡'}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-xl font-extrabold tracking-tight text-ink">
            {p.name as string}
            {archived && (
              <span className="inline-flex items-center gap-1 rounded-pill bg-surface-2 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-ink-faint">
                <Archive className="h-3 w-3" /> Archived
              </span>
            )}
          </h1>
          <p className="mt-0.5 text-[13px] text-ink-muted">{(p.description as string) || 'No description'}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-ink-faint">
            <span className="font-mono">{p.slug as string}</span>
            <span className="inline-flex items-center gap-1">
              <Play className="h-3.5 w-3.5" /> {p.times_run as number} runs
            </span>
            {p.last_run_at ? <span>last {relativeTime(p.last_run_at as string)}</span> : null}
          </div>
        </div>
        <PipelineHeaderActions slug={p.slug as string} archived={archived} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        {/* Flow timeline — the deck's language: purple nodes = Cortex works, YOU = you decide */}
        <Panel className="p-5">
          <div className="mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            The flow
          </div>
          {(p.intro as string) && (
            <p className="mb-5 rounded-[12px] bg-surface-2 px-4 py-3 text-[13px] leading-relaxed text-ink-muted">
              {p.intro as string}
            </p>
          )}
          {steps.length === 0 ? (
            <p className="text-[13px] text-ink-faint">
              Legacy pipeline (free-form instruction).{' '}
              <Link
                href={`/pipelines/${p.slug as string}/edit`}
                className="font-semibold text-primary hover:text-primary-strong"
              >
                Rebuild it with structured steps
              </Link>
              .
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
                      <span className="z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full border-2 border-amber bg-amber-soft">
                        <UserCheck className="h-4 w-4 text-amber" />
                      </span>
                    ) : (
                      <span className="z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-strong text-[13px] font-extrabold text-white shadow-pop">
                        {i + 1}
                      </span>
                    )}
                    <div className="min-w-0 flex-1 pt-1">
                      {s.checkpoint && (
                        <div className="mb-0.5 text-[10px] font-extrabold uppercase tracking-[0.14em] text-amber">
                          Checkpoint · you decide
                        </div>
                      )}
                      <div className="text-[13.5px] font-bold text-ink">{s.title}</div>
                      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">{s.detail}</p>
                      {(s.tools ?? []).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {(s.tools ?? []).map((t) => (
                            <span
                              key={t}
                              className="inline-flex items-center gap-1 rounded-full bg-primary-soft px-2 py-0.5 font-mono text-[10.5px] font-semibold text-primary"
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
              <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                Parameters
              </div>
              <ul className="space-y-2">
                {pipelineParams.map((param) => (
                  <li key={param.name} className="text-[12.5px]">
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[11px] font-semibold text-ink">
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
            <div className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Recent runs
            </div>
            {runs.length === 0 ? (
              <p className="text-[12px] text-ink-faint">Never run yet.</p>
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
                          {u?.name || u?.email || 'Unknown'}{' '}
                          <span className="font-normal text-ink-faint">
                            · {relativeTime(r.started_at)}
                          </span>
                        </div>
                        {r.summary && (
                          <p className="mt-0.5 text-[11.5px] leading-snug text-ink-muted">{r.summary}</p>
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
