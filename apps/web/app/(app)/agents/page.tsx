import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { Card } from '@/components/ui/card';

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
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Agents</h1>
      <div className="grid gap-3 sm:grid-cols-2">
        {agents.map((a) => (
          <Link key={a.id} href={`/agents/${a.slug}`} className="block">
            <Card className="hover:border-neutral-400 transition-colors">
              <div className="font-medium">{a.name}</div>
              <div className="text-xs text-neutral-500 mt-1">
                {a.teams?.[0]?.name ?? 'No team'} &middot; {a.default_model} &middot;{' '}
                {a.allowed_tool_ids.length} tools
              </div>
              <div className="text-xs text-neutral-400 font-mono mt-0.5">{a.slug}</div>
            </Card>
          </Link>
        ))}
        {agents.length === 0 && (
          <p className="text-sm text-neutral-500 col-span-2">No agents configured.</p>
        )}
      </div>
    </div>
  );
}
