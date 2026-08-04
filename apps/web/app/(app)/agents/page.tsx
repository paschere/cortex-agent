import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { Bot, Cpu, Wrench, Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  default_model: string;
  allowed_tool_ids: string[];
  teams: { name: string }[] | null;
}

export default async function AgentsPage() {
  const sb = getSupabaseServiceClient();
  const { data } = await sb
    .from('agents')
    .select('id, slug, name, default_model, allowed_tool_ids, teams(name)')
    .eq('archived', false)
    .order('name');

  const agents: AgentRow[] = (data ?? []) as unknown as AgentRow[];

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle={`${agents.length} agent${agents.length === 1 ? '' : 's'} configured across your teams`}
        icon={<Bot className="h-5 w-5" />}
      />

      {agents.length === 0 ? (
        <Panel className="p-10 text-center">
          <Bot className="mx-auto mb-3 h-8 w-8 text-ink-faint" />
          <p className="text-[13px] font-semibold text-ink">No agents are configured</p>
          <p className="mx-auto mt-1 max-w-md text-[13px] leading-relaxed text-ink-muted">
            An agent is a named model with a fixed tool list. Ops provisions them — ask an
            administrator to add the first one.
          </p>
        </Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map((a) => {
            const isCortex = a.slug === 'cortex';
            return (
              <Link key={a.id} href={`/agents/${a.slug}`} className="group block">
                <Panel className="flex h-full flex-col gap-3 p-4 transition-colors group-hover:border-border-strong">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-bold text-ink">{a.name}</span>
                        {isCortex && (
                          <span className="shrink-0 rounded-card border border-primary/30 bg-primary-soft px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-primary-ink">
                            Super-agent
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-ink-faint">
                        <span className="tabular">{a.slug}</span> ·{' '}
                        {a.teams?.[0]?.name ?? 'No team'}
                      </div>
                    </div>
                    <span
                      className={
                        isCortex
                          ? 'grid h-10 w-10 shrink-0 place-items-center rounded-card bg-primary text-white'
                          : 'grid h-10 w-10 shrink-0 place-items-center rounded-card bg-primary-soft text-primary'
                      }
                    >
                      {isCortex ? (
                        <Sparkles className="h-5 w-5" />
                      ) : (
                        <Bot className="h-5 w-5" />
                      )}
                    </span>
                  </div>

                  <div className="mt-auto flex items-center justify-between border-t border-border pt-2.5 text-[11.5px] text-ink-faint">
                    <span className="inline-flex items-center gap-1 truncate">
                      <Cpu className="h-3.5 w-3.5 shrink-0" />
                      <span className="tabular truncate">{a.default_model}</span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1">
                      <Wrench className="h-3.5 w-3.5" />
                      <span className="tabular">{a.allowed_tool_ids.length}</span> tool
                      {a.allowed_tool_ids.length === 1 ? '' : 's'}
                    </span>
                  </div>
                </Panel>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
