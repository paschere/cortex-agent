import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { Workflow, Play, Hash, Clock } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';

interface ParamDef {
  name: string;
  description?: string;
  required?: boolean;
}

interface PipelineRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  params: ParamDef[];
  times_run: number;
  last_run_at: string | null;
  created_at: string;
}

export const dynamic = 'force-dynamic';

export default async function PipelinesPage() {
  await requireSession();
  const sb = getSupabaseServiceClient();
  const { data } = await sb
    .from('pipelines')
    .select('id, slug, name, description, params, times_run, last_run_at, created_at')
    .eq('archived', false)
    .order('times_run', { ascending: false });

  const pipelines = (data ?? []) as unknown as PipelineRow[];

  return (
    <>
      <PageHeader
        title="Pipelines"
        subtitle="Reusable playbooks — define once in chat, run anywhere: web, Claude, or on a schedule"
        icon={<Workflow className="h-5 w-5" />}
      />

      {pipelines.length === 0 ? (
        <Panel className="p-10 text-center text-[13px] text-ink-faint">
          <Workflow className="mx-auto mb-3 h-8 w-8 text-primary" />
          <p className="mb-1 font-semibold text-ink">No pipelines yet</p>
          <p className="mx-auto max-w-md">
            Ask Zippy to create one in{' '}
            <Link href="/chat" className="font-semibold text-primary hover:text-primary-strong">
              chat
            </Link>
            : <em>&ldquo;Create a pipeline that every Friday prepares each client&apos;s active-candidates
            report and drafts the emails for my approval.&rdquo;</em>
          </p>
        </Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {pipelines.map((p) => (
            <Panel key={p.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-bold text-ink">{p.name}</div>
                  <div className="truncate font-mono text-[11px] text-ink-faint">{p.slug}</div>
                </div>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
                  <Workflow className="h-4 w-4" />
                </span>
              </div>

              {p.description && (
                <p className="line-clamp-2 text-[12.5px] leading-snug text-ink-muted">{p.description}</p>
              )}

              {p.params.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {p.params.map((param) => (
                    <span
                      key={param.name}
                      title={param.description}
                      className="inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-muted"
                    >
                      <Hash className="h-3 w-3" />
                      {param.name}
                      {param.required !== false && <span className="text-rose">*</span>}
                    </span>
                  ))}
                </div>
              )}

              <div className="mt-auto flex items-center justify-between border-t border-border pt-2.5 text-[11.5px] text-ink-faint">
                <span className="inline-flex items-center gap-1">
                  <Play className="h-3.5 w-3.5" />
                  {p.times_run} run{p.times_run === 1 ? '' : 's'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3.5 w-3.5" />
                  {p.last_run_at ? `last ${relativeTime(p.last_run_at)}` : 'never run'}
                </span>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
