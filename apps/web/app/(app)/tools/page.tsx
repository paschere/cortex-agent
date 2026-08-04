import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { CONFIRMATION_NOTES, confirmationReason } from '@/lib/confirmation-notes';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { deniedToolPatterns } from '@/lib/tool-access';
import {
  type BlastRadius,
  type RiskLevel,
  type Sensitivity,
  familyOf,
  matchesAnyPattern,
  matchesPattern,
} from '@/lib/tool-taxonomy';
import { classify, decide, listTools } from '@cortex/agent-tools';
import { Layers, Lock, PlugZap, ShieldAlert, Wrench } from 'lucide-react';
import { type CatalogTeam, type CatalogTool, ToolsCatalog } from './_components/ToolsCatalog';

export const dynamic = 'force-dynamic';

/**
 * Everything on this page that needs the live tool registry is resolved HERE,
 * in a server component, and handed down as plain serialisable props.
 * `@cortex/agent-tools` must never reach a client module — it pulls
 * `node:crypto`, `node:dns` and pdf-parse's `fs` access into the browser bundle
 * and breaks the production build (see apps/web/app/api/settings/preferences/schema.ts).
 */

interface AgentRow {
  slug: string;
  name: string;
  allowed_tool_ids: string[] | null;
}

interface PermissionRow {
  team_id: string;
  tool_pattern: string;
}

/**
 * The security layer's classifier is payload-dependent by design (an email with
 * a salary in it outranks the same email without). A catalogue has no payload,
 * so we classify with an empty input to get each tool's BASELINE risk — its
 * declared sensitivity and blast radius — and pin the clock to mid-day Bogota
 * so the time-of-day signal, which is a property of the call and not of the
 * tool, never leaks into a static listing.
 */
const CATALOG_CLOCK = new Date(Date.UTC(2024, 0, 1, 17, 0, 0));

export default async function ToolsPage({
  searchParams,
}: {
  searchParams: Promise<{ team?: string }>;
}) {
  const session = await requireSession();
  const isAdmin = session.role === 'org_admin';
  const { team: requestedTeamId = '' } = await searchParams;

  const sb = getSupabaseServiceClient();

  const [{ data: agentData }, { data: permissionData }, { data: integrationData }, myDenied] =
    await Promise.all([
      sb.from('agents').select('slug, name, allowed_tool_ids'),
      // Team permissions are a DENY-list (0038_team_tool_permissions.sql): only
      // allowed = false rows restrict anything.
      sb
        .from('team_tool_permissions')
        .select('team_id, tool_pattern')
        .eq('allowed', false),
      sb.from('integrations').select('provider').eq('user_id', session.id),
      // Patterns denied to the signed-in user by their own teams.
      deniedToolPatterns(sb, session.id),
    ]);

  const agents = (agentData ?? []) as AgentRow[];
  const deniedRows = (permissionData ?? []) as PermissionRow[];
  const deniedPatterns = [...new Set(deniedRows.map((r) => r.tool_pattern))];

  // HubSpot runs on a workspace-wide private app token when configured, so
  // nobody has to connect it individually.
  const connectedProviders = new Set<string>(
    ((integrationData ?? []) as { provider: string }[]).map((r) => r.provider),
  );
  if (process.env.HUBSPOT_PRIVATE_APP_TOKEN) connectedProviders.add('hubspot');

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
      teamDenied = deniedRows
        .filter((r) => r.team_id === selectedTeamId)
        .map((r) => r.tool_pattern);
    }
  }

  // Team NAMES are admin-only detail; everyone else sees availability relative
  // to their own teams and nothing about anyone else's.
  const teamNameById = new Map(teams.map((t) => [t.id, t.name]));

  const tools: CatalogTool[] = listTools()
    .filter((t) => !t.id.startsWith('test.'))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((t) => {
      const classification = classify({
        tool: { id: t.id, requiresConfirmation: t.requiresConfirmation },
        input: {},
        ctx: { now: CATALOG_CLOCK },
        surface: 'web',
      });
      // Second pass with an address outside the company in the payload. The
      // classifier only promotes a tool to `external_send` when the policy has
      // declared it content-delivering, so this is a precise probe for "this
      // one can put something in front of an outsider" rather than a guess —
      // and it is why gmail.send_draft reads differently from gmail.draft.
      const outbound = classify({
        tool: { id: t.id, requiresConfirmation: t.requiresConfirmation },
        input: { to: 'someone@example.invalid' },
        ctx: { now: CATALOG_CLOCK },
        surface: 'web',
      });
      const canLeaveCompany = outbound.blastRadius === 'external_send';
      const needsApproval =
        Boolean(t.requiresConfirmation) ||
        decide(classification) === 'confirm' ||
        decide(outbound) === 'confirm';
      const providers = [...new Set((t.requiredScopes ?? []).map((r) => r.provider as string))];

      const restrictedFor = isAdmin
        ? [
            ...new Set(
              deniedRows
                .filter((r) => matchesPattern(t.id, r.tool_pattern))
                .map((r) => teamNameById.get(r.team_id) ?? 'Unknown team')
                .filter(Boolean),
            ),
          ].sort()
        : [];

      return {
        id: t.id,
        family: familyOf(t.id),
        description: t.description,
        needsApproval,
        // Only tools with an explicit note get one — the generic fallback would
        // be noise repeated 40 times.
        approvalReason: needsApproval
          ? (CONFIRMATION_NOTES[t.id] ?? confirmationReason(t.id))
          : null,
        riskLevel: classification.riskLevel as RiskLevel,
        sensitivity: classification.sensitivity as Sensitivity,
        blastRadius: classification.blastRadius as BlastRadius,
        canLeaveCompany,
        // Only meaningful when it differs from the baseline: what the guardrail
        // scores the same call at once it is addressed outside the company.
        outboundRiskLevel:
          canLeaveCompany && outbound.riskLevel !== classification.riskLevel
            ? (outbound.riskLevel as RiskLevel)
            : null,
        ratePerMinute: t.rateLimit?.perMinute ?? null,
        providers,
        missingProviders: providers.filter((p) => !connectedProviders.has(p)),
        agents: agents
          .filter((a) => (a.allowed_tool_ids ?? []).some((pat) => matchesPattern(t.id, pat)))
          .map((a) => a.name)
          .sort(),
        restrictedFor,
        restrictedSomewhere: matchesAnyPattern(t.id, deniedPatterns),
        deniedForMe: matchesAnyPattern(t.id, myDenied),
      } satisfies CatalogTool;
    });

  const total = tools.length;
  const familyCount = new Set(tools.map((t) => t.family)).size;
  const approvalCount = tools.filter((t) => t.needsApproval).length;
  const restrictedCount = tools.filter((t) => t.restrictedSomewhere).length;
  const needsConnectionCount = tools.filter((t) => t.missingProviders.length > 0).length;

  /**
   * The header of an inventory, not a row of dashboard tiles: one ruled block,
   * counts in mono, each column naming what the organisation actually holds.
   */
  const stats = [
    { label: 'Tools', value: total, sub: 'in the live registry', icon: Wrench, tone: 'text-ink' },
    {
      label: 'Families',
      value: familyCount,
      sub: 'systems Cortex reaches',
      icon: Layers,
      tone: 'text-ink',
    },
    {
      label: 'Need approval',
      value: approvalCount,
      sub: 'a person confirms first',
      icon: ShieldAlert,
      tone: approvalCount > 0 ? 'text-amber' : 'text-ink',
    },
    {
      label: 'Restricted',
      value: restrictedCount,
      sub: restrictedCount > 0 ? 'denied to at least one team' : 'no team blocks any tool',
      icon: Lock,
      tone: restrictedCount > 0 ? 'text-rose' : 'text-emerald',
    },
    {
      label: 'Not connected',
      value: needsConnectionCount,
      sub: needsConnectionCount > 0 ? 'waiting on an integration' : 'every integration is linked',
      icon: PlugZap,
      tone: needsConnectionCount > 0 ? 'text-amber' : 'text-emerald',
    },
  ];

  return (
    <>
      <PageHeader
        title="Tools"
        subtitle="What this organisation has enabled Cortex to do, grouped by the system it touches. Access is granted per team; risky actions ask a person first."
        icon={<Wrench className="h-5 w-5" />}
      />

      {/* Hairlines come from the gap showing the border colour through, so the
          rules stay correct at every breakpoint the grid reflows to. */}
      <Panel className="mb-5 overflow-hidden bg-border">
        <div className="grid grid-cols-2 gap-px sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((s) => (
            <div key={s.label} className="bg-surface p-4">
              <div className="flex items-center gap-1.5">
                <s.icon className={`h-3.5 w-3.5 ${s.tone}`} />
                <span className="field-label">{s.label}</span>
              </div>
              <div className={`stat-num mt-1.5 text-[26px] leading-none ${s.tone}`}>{s.value}</div>
              <div className="mt-1.5 text-[11px] leading-snug text-ink-faint">{s.sub}</div>
            </div>
          ))}
        </div>
      </Panel>

      <ToolsCatalog
        tools={tools}
        isAdmin={isAdmin}
        teams={teams}
        selectedTeamId={selectedTeamId}
        initialTeamDenied={teamDenied}
      />
    </>
  );
}
