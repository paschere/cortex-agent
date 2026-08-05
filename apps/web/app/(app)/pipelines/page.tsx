import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { Workflow, Play, Hash, Clock, UserCheck, Plus, Archive, ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { PipelineCardMenu } from './_components/PipelineCardMenu';

interface ParamDef {
  name: string;
  description?: string;
  required?: boolean;
}

interface StepDef {
  title: string;
  checkpoint?: boolean;
}

interface PipelineRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  emoji: string;
  params: ParamDef[];
  steps: StepDef[];
  times_run: number;
  last_run_at: string | null;
  archived: boolean;
}

export const dynamic = 'force-dynamic';

export default async function PipelinesPage() {
  const user = await requireSession();
  const sb = getOrgScopedClient(user.organization.id);
  const { data } = await sb
    .from('pipelines')
    .select('id, slug, name, description, emoji, params, steps, times_run, last_run_at, archived')
    .order('times_run', { ascending: false });

  const all = (data ?? []) as unknown as PipelineRow[];
  const pipelines = all.filter((p) => !p.archived);
  const archived = all.filter((p) => p.archived);

  return (
    <>
      <PageHeader
        title="Flujos"
        subtitle="Instructivos que escribes una vez y ejecutas donde quieras: aquí, desde Claude o en una rutina programada. Los armas en esta pantalla o hablando en el chat."
        icon={<Workflow className="h-5 w-5" />}
        actions={
          <Link
            href="/pipelines/new"
            className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-[12.5px] font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong motion-reduce:transform-none motion-reduce:transition-none"
          >
            <Plus className="h-4 w-4" /> Nuevo flujo
          </Link>
        }
      />

      {pipelines.length === 0 ? (
        <Panel className="p-10 text-center text-[13px] text-ink-muted">
          <Workflow className="mx-auto mb-3 h-7 w-7 text-primary" />
          <p className="mb-1 text-[15px] font-bold text-ink">Todavía no hay flujos</p>
          <p className="mx-auto max-w-md leading-relaxed">
            Un flujo es un instructivo que escribes una vez y ejecutas donde quieras: aquí, desde
            Claude o en una rutina. Ármalo paso a paso, o pídeselo a Cortex en el chat:{' '}
            <em>
              &ldquo;Crea un flujo que todos los viernes prepare el reporte de candidatos activos de
              cada cliente y me deje los correos listos para aprobar.&rdquo;
            </em>
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Link
              href="/pipelines/new"
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-[12.5px] font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong motion-reduce:transform-none motion-reduce:transition-none"
            >
              <Plus className="h-3.5 w-3.5" /> Nuevo flujo
            </Link>
            <Link
              href="/chat"
              className="rounded-pill border border-border-strong bg-surface px-4 py-2 text-[12.5px] font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2 motion-reduce:transform-none motion-reduce:transition-none"
            >
              Pedírselo a Cortex en el chat
            </Link>
          </div>
        </Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {pipelines.map((p) => (
            <PipelineCard key={p.id} p={p} />
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <details className="group mt-6">
          <summary className="field-label flex cursor-pointer list-none items-center gap-2 transition-colors hover:text-ink">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            <Archive className="h-3.5 w-3.5" />
            Archivados ({archived.length})
          </summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {archived.map((p) => (
              <PipelineCard key={p.id} p={p} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}

function PipelineCard({ p }: { p: PipelineRow }) {
  const steps = p.steps ?? [];
  return (
    <div className="relative">
      <Link href={`/pipelines/${p.slug}`} className="group block h-full">
        <Panel
          className={`flex h-full flex-col gap-3 p-4 transition-all duration-150 group-hover:-translate-y-px group-hover:border-border-strong motion-reduce:transform-none motion-reduce:transition-none ${
            p.archived ? 'opacity-70' : ''
          }`}
        >
          <div className="flex items-start gap-2.5 pr-9">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-card border border-border bg-surface-2 text-[19px]">
              {p.emoji || '⚡'}
            </span>
            <div className="min-w-0">
              <div className="truncate text-[14px] font-bold text-ink">{p.name}</div>
              <div className="truncate font-mono text-[11px] text-ink-faint">{p.slug}</div>
            </div>
          </div>

          {p.description && (
            <p className="line-clamp-2 text-[12.5px] leading-snug text-ink-muted">{p.description}</p>
          )}

          {/* Step track: one mark per step, amber = a person has to decide. */}
          {steps.length > 0 && (
            <div
              className="flex items-center gap-1"
              title={steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}
            >
              {steps.map((s, i) => (
                <span key={`${p.id}-${i}`} className="flex items-center gap-1">
                  {i > 0 && <span className="h-px w-2.5 bg-border" />}
                  {s.checkpoint ? (
                    <span className="grid h-[18px] w-[18px] place-items-center rounded-sm border border-amber/50 bg-amber-soft">
                      <UserCheck className="h-2.5 w-2.5 text-amber" />
                    </span>
                  ) : (
                    <span className="h-2 w-2 rounded-full bg-primary" />
                  )}
                </span>
              ))}
            </div>
          )}

          {(p.params ?? []).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {p.params.map((param) => (
                <span
                  key={param.name}
                  title={param.description}
                  className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted"
                >
                  <Hash className="h-3 w-3" />
                  {param.name}
                  {param.required !== false && <span className="text-rose">*</span>}
                </span>
              ))}
            </div>
          )}

          <div className="tabular mt-auto flex items-center justify-between border-t border-border pt-2.5 text-[11px] text-ink-faint">
            <span className="inline-flex items-center gap-1">
              <Play className="h-3.5 w-3.5" />
              {p.times_run} {p.times_run === 1 ? 'ejecución' : 'ejecuciones'}
            </span>
            <span className="inline-flex items-center gap-1">
              {p.archived ? (
                <>
                  <Archive className="h-3.5 w-3.5" /> archivado
                </>
              ) : (
                <>
                  <Clock className="h-3.5 w-3.5" />
                  {p.last_run_at ? `última ${relativeTime(p.last_run_at)}` : 'sin ejecutar'}
                </>
              )}
            </span>
          </div>
        </Panel>
      </Link>

      <div className="absolute right-3 top-3 z-10">
        <PipelineCardMenu slug={p.slug} archived={p.archived} />
      </div>
    </div>
  );
}
