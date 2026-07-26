import { listTools } from '@zipdev/agent-tools';
import { BookOpenCheck, Layers, ShieldAlert, Wrench } from 'lucide-react';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { deniedToolPatterns } from '@/lib/tool-access';
import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/panel';
import { ToolsCatalog, type CatalogTeam, type CatalogTool } from './_components/ToolsCatalog';

export const dynamic = 'force-dynamic';

interface AgentRow {
  slug: string;
  name: string;
  allowed_tool_ids: string[] | null;
}

// Same semantics as filterTools/matchPattern in @zipdev/agent-tools:
// entries are either exact tool ids or family wildcards like 'hubspot.*'.
function matchPattern(pat: string, id: string): boolean {
  if (pat.endsWith('.*')) return id.startsWith(pat.slice(0, -1));
  return pat === id;
}

export default async function ToolsPage({
  searchParams,
}: {
  searchParams: Promise<{ team?: string }>;
}) {
  const session = await requireSession();
  const isAdmin = session.role === 'org_admin';
  const { team: requestedTeamId = '' } = await searchParams;

  const sb = getSupabaseServiceClient();
  const { data: agentData } = await sb.from('agents').select('slug, name, allowed_tool_ids');
  const agents = (agentData ?? []) as AgentRow[];

  // Patterns denied to the signed-in user by their own teams — used for the
  // "Not available to your team" badge on the read-only catalog.
  const myDenied = await deniedToolPatterns(sb, session.id);

  let teams: CatalogTeam[] = [];
  let selectedTeamId = '';
  let teamDenied: string[] = [];
  if (isAdmin) {
    const [{ data: teamData }, { data: memberData }] = await Promise.all([
      sb.from('teams').select('id, name').order('name', { ascending: true }),
      sb.from('team_members').select('team_id'),
    ]);
    const memberCounts = ((memberData ?? []) as { team_id: string }[]).reduce<
      Record<string, number>
    >((acc, m) => {
      acc[m.team_id] = (acc[m.team_id] ?? 0) + 1;
      return acc;
    }, {});
    teams = ((teamData ?? []) as { id: string; name: string }[]).map((t) => ({
      id: t.id,
      name: t.name,
      memberCount: memberCounts[t.id] ?? 0,
    }));

    if (requestedTeamId && teams.some((t) => t.id === requestedTeamId)) {
      selectedTeamId = requestedTeamId;
      const { data: rows } = await sb
        .from('team_tool_permissions')
        .select('tool_pattern')
        .eq('team_id', selectedTeamId)
        .eq('allowed', false);
      teamDenied = ((rows ?? []) as { tool_pattern: string }[]).map((r) => r.tool_pattern);
    }
  }

  const tools: CatalogTool[] = listTools()
    .filter((t) => !t.id.startsWith('test.'))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => ({
      id: t.id,
      description: t.description,
      write: !!t.requiresConfirmation,
      ratePerMinute: t.rateLimit?.perMinute ?? null,
      agents: agents
        .filter((a) => (a.allowed_tool_ids ?? []).some((pat) => matchPattern(pat, t.id)))
        .map((a) => a.name),
    }));

  const total = tools.length;
  const familyCount = new Set(tools.map((t) => t.id.split('.')[0] ?? '')).size;
  const gated = tools.filter((t) => t.write).length;
  const readOnly = total - gated;

  return (
    <>
      <PageHeader
        title="Tools"
        subtitle={`${total} tools across ${familyCount} families — ${gated} write actions gated behind confirmation`}
        icon={<Wrench className="h-5 w-5" />}
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Total tools"
          value={String(total)}
          sub="Live registry, all families"
          icon={<Wrench className="h-4 w-4" />}
          tone="primary"
        />
        <StatCard
          label="Families"
          value={String(familyCount)}
          sub="Grouped by id prefix"
          icon={<Layers className="h-4 w-4" />}
          tone="sky"
          delay={40}
        />
        <StatCard
          label="Read-only"
          value={String(readOnly)}
          sub="Run without confirmation"
          icon={<BookOpenCheck className="h-4 w-4" />}
          tone="emerald"
          delay={80}
        />
        <StatCard
          label="Confirmation-gated"
          value={String(gated)}
          sub="Write actions need approval"
          icon={<ShieldAlert className="h-4 w-4" />}
          tone="amber"
          delay={120}
        />
      </div>

      <ToolsCatalog
        tools={tools}
        isAdmin={isAdmin}
        teams={teams}
        selectedTeamId={selectedTeamId}
        initialTeamDenied={teamDenied}
        myDenied={myDenied}
      />
    </>
  );
}
