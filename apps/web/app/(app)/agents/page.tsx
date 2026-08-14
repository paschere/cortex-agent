import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
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
  const user = await requireSession();
  const sb = getOrgScopedClient(user.organization.id);
  const { data } = await sb
    .from('agents')
    .select('id, slug, name, default_model, allowed_tool_ids, teams(name)')
    .eq('archived', false)
    .order('name');

  const agents: AgentRow[] = (data ?? []) as unknown as AgentRow[];

  return (
    <>
      <PageHeader
        title="Agentes"
        subtitle={`${agents.length} ${agents.length === 1 ? 'agente configurado' : 'agentes configurados'} en tus equipos`}
        icon={<Bot className="h-5 w-5" />}
      />

      {agents.length === 0 ? (
        <Panel className="p-10 text-center">
          <Bot className="mx-auto mb-3 h-8 w-8 text-ink-faint" />
          <p className="text-sm font-semibold text-ink">No hay agentes configurados</p>
          <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-ink-muted">
            Un agente es un modelo con nombre y una lista fija de herramientas. Los habilita el
            equipo técnico: pídele a un administrador que cree el primero.
          </p>
        </Panel>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {agents.map((a) => {
            const isCortex = a.slug === 'cortex';
            return (
              <Link key={a.id} href={`/agents/${a.slug}`} className="group block">
                <Panel className="flex h-full flex-col gap-3 p-4 transition-all duration-150 group-hover:-translate-y-px group-hover:border-border-strong motion-reduce:transform-none motion-reduce:transition-none">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-base font-bold text-ink">{a.name}</span>
                        {isCortex && (
                          <span className="shrink-0 rounded-pill border border-primary/30 bg-primary-soft px-2 py-0.5 text-micro font-semibold text-primary-ink">
                            Super-agente
                          </span>
                        )}
                      </div>
                      <div className="truncate text-micro text-ink-faint">
                        <span className="tabular">{a.slug}</span> ·{' '}
                        {a.teams?.[0]?.name ?? 'Sin equipo'}
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

                  <div className="mt-auto flex items-center justify-between border-t border-border pt-2.5 text-micro text-ink-faint">
                    <span className="inline-flex items-center gap-1 truncate">
                      <Cpu className="h-3.5 w-3.5 shrink-0" />
                      <span className="tabular truncate">{a.default_model}</span>
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1">
                      <Wrench className="h-3.5 w-3.5" />
                      <span className="tabular">{a.allowed_tool_ids.length}</span>{' '}
                      {a.allowed_tool_ids.length === 1 ? 'herramienta' : 'herramientas'}
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
