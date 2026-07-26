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
        <Panel className="p-10 text-center text-[13px] text-ink-faint">
          <Bot className="mx-auto mb-3 h-8 w-8 text-primary" />
          <p className="mb-1 font-semibold text-ink">No agents configured</p>
          <p className="mx-auto max-w-md">Agents will appear here once they are provisioned.</p>
        </Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map((a) => {
            const isZippy = a.slug === 'zippy';
            return (
              <Link key={a.id} href={`/agents/${a.slug}`} className="group block">
                <Panel className="flex h-full flex-col gap-3 p-4 transition-all group-hover:-translate-y-0.5 group-hover:shadow-pop">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[14px] font-bold text-ink">{a.name}</span>
                        {isZippy && (
                          <span className="shrink-0 rounded-pill bg-primary-soft px-2 py-0.5 text-[10.5px] font-bold uppercase text-primary-ink">
                            Super-agent
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[11px] text-ink-faint">
                        <span className="font-mono">{a.slug}</span> · {a.teams?.[0]?.name ?? 'No team'}
                      </div>
                    </div>
                    {isZippy ? (
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-gradient-to-br from-primary to-primary-strong text-white shadow-pop">
                        <Sparkles className="h-5 w-5" />
                      </span>
                    ) : (
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-primary-soft text-primary">
                        <Bot className="h-5 w-5" />
                      </span>
                    )}
                  </div>

                  <div className="mt-auto flex items-center justify-between border-t border-border pt-2.5 text-[11.5px] text-ink-faint">
                    <span className="inline-flex items-center gap-1 truncate">
                      <Cpu className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate font-mono">{a.default_model}</span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1">
                      <Wrench className="h-3.5 w-3.5" />
                      {a.allowed_tool_ids.length} tool{a.allowed_tool_ids.length === 1 ? '' : 's'}
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
