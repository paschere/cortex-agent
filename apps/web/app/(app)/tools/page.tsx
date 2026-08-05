import { PageHeader } from '@/components/ui/page-header';
import { CONFIRMATION_NOTES, confirmationReason } from '@/lib/confirmation-notes';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns } from '@/lib/tool-access';
import {
  type BlastRadius,
  type BlockReason,
  type RiskLevel,
  type Sensitivity,
  credentialRequirement,
  familyOf,
  groupOfFamily,
  matchesAnyPattern,
  matchesPattern,
  toolActionLabel,
} from '@/lib/tool-taxonomy';
import { USAGE_SCAN_LIMIT, USAGE_WINDOW_DAYS, fetchToolUsage } from '@/lib/tool-usage';
import {
  CUSTOM_TOOLS_TABLE,
  type CustomToolRow,
  SAFE_COLUMNS,
  classify,
  customToolId,
  decide,
  fetchEnabledExternalTools,
  listTools,
} from '@cortex/agent-tools';
import { Wrench } from 'lucide-react';
import {
  type CatalogTeam,
  type CatalogTool,
  type McpServerSummary,
  ToolsControlCentre,
} from './_components/ToolsCatalog';

export const dynamic = 'force-dynamic';

/**
 * Everything on this page that needs the live tool registry is resolved HERE,
 * in a server component, and handed down as plain serialisable props.
 * `@cortex/agent-tools` must never reach a client module — it pulls
 * `node:crypto`, `node:dns` and pdf-parse's `fs` access into the browser bundle
 * and breaks the production build (see apps/web/app/api/settings/preferences/schema.ts).
 */

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  allowed_tool_ids: string[] | null;
}

interface PermissionRow {
  team_id: string;
  tool_pattern: string;
}

interface McpServerRow {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  trusted: boolean;
  tool_count: number | null;
  last_checked_at: string | null;
  last_error: string | null;
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

  const sb = getOrgScopedClient(session.organization.id);

  const [
    { data: agentData },
    { data: permissionData },
    { data: integrationData },
    { data: mcpServerData },
    { data: customToolData },
    myDenied,
    externalServers,
    usage,
  ] = await Promise.all([
    // Archived agents (0037, 0063) are history, not grants: listing them here
    // would credit a retired agent with access nobody can actually exercise.
    sb
      .from('agents')
      .select('id, slug, name, allowed_tool_ids')
      .eq('archived', false),
    // Team permissions are a DENY-list (0038_team_tool_permissions.sql): only
    // allowed = false rows restrict anything.
    sb
      .from('team_tool_permissions')
      .select('team_id, tool_pattern')
      .eq('allowed', false),
    sb.from('integrations').select('provider').eq('user_id', session.id),
    // Every server this person registered, including the ones they switched
    // off — "it is off" is an answer to why a tool did not run, and the fetch
    // below only ever returns the enabled ones.
    sb
      .from('user_mcp_servers')
      .select('id, name, url, enabled, trusted, tool_count, last_checked_at, last_error')
      .eq('user_id', session.id)
      .order('created_at', { ascending: true }),
    // The workspace's own tools (0067), listed here whether they are on or off
    // — "está apagada" is one of the answers this page exists to give.
    // SAFE_COLUMNS deliberately: the encrypted secret never reaches a page.
    sb
      .from(CUSTOM_TOOLS_TABLE)
      .select(SAFE_COLUMNS)
      .order('slug', { ascending: true }),
    // Patterns denied to the signed-in user by their own teams.
    deniedToolPatterns(sb, session.id),
    // The same call the chat turn makes, so this screen lists exactly what the
    // model would be offered — and refreshes a stale manifest on the way past.
    // Best-effort: an unreachable MCP server must not take the page down.
    fetchEnabledExternalTools(sb, session.id).catch(() => []),
    fetchToolUsage(sb),
  ]);

  const agents = (agentData ?? []) as AgentRow[];
  const deniedRows = (permissionData ?? []) as PermissionRow[];
  const deniedPatterns = [...new Set(deniedRows.map((r) => r.tool_pattern))];
  const mcpServerRows = (mcpServerData ?? []) as McpServerRow[];

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

  // Which of MY teams denies a pattern — the sentence a non-admin needs is
  // "Operaciones lo bloqueó", not "algún equipo lo bloqueó".
  const myTeamIds = new Set<string>();
  if (myDenied.length > 0) {
    const { data: myMemberships } = await sb
      .from('team_members')
      .select('team_id')
      .eq('user_id', session.id);
    for (const m of (myMemberships ?? []) as { team_id: string }[]) myTeamIds.add(m.team_id);
  }
  const myTeamNames = new Map<string, string[]>();
  if (myTeamIds.size > 0) {
    const { data: myTeams } = await sb
      .from('teams')
      .select('id, name')
      .in('id', [...myTeamIds]);
    for (const t of (myTeams ?? []) as { id: string; name: string }[]) {
      for (const row of deniedRows.filter((r) => r.team_id === t.id)) {
        const list = myTeamNames.get(row.tool_pattern) ?? [];
        if (!list.includes(t.name)) list.push(t.name);
        myTeamNames.set(row.tool_pattern, list);
      }
    }
  }

  /** Names of the teams of mine that block `toolId`, for the "why" sentence. */
  function blockingTeamsFor(toolId: string): string[] {
    const names = new Set<string>();
    for (const [pattern, teamNames] of myTeamNames) {
      if (matchesPattern(toolId, pattern)) for (const n of teamNames) names.add(n);
    }
    return [...names].sort();
  }

  const registryTools: CatalogTool[] = listTools()
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
      const missingProviders = providers.filter((p) => !connectedProviders.has(p));

      const grantedBy = agents.filter((a) =>
        (a.allowed_tool_ids ?? []).some((pat) => matchesToolPattern(t.id, pat)),
      );

      const restrictedFor = isAdmin
        ? [
            ...new Set(
              deniedRows
                .filter((r) => matchesPattern(t.id, r.tool_pattern))
                .map((r) => teamNameById.get(r.team_id) ?? 'Equipo desconocido')
                .filter(Boolean),
            ),
          ].sort()
        : [];

      // The credential check is the only part of this that reads process.env,
      // and it reads NAMES only — a value never leaves the server.
      const requirement = credentialRequirement(t.id);
      const missingCredentials = requirement ? requirement.vars.filter((v) => !process.env[v]) : [];

      const deniedForMe = matchesAnyPattern(t.id, myDenied);
      const blockedForMe: BlockReason[] = [];
      if (grantedBy.length === 0) blockedForMe.push('not_granted');
      if (deniedForMe) blockedForMe.push('team_blocked');
      if (missingProviders.length > 0) blockedForMe.push('integration');
      if (missingCredentials.length > 0 && requirement?.blocking) blockedForMe.push('credential');

      return {
        id: t.id,
        kind: 'registry',
        title: toolActionLabel(t.id),
        family: familyOf(t.id),
        group: groupOfFamily(familyOf(t.id)),
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
        missingProviders,
        agents: grantedBy.map((a) => a.name).sort(),
        agentSlugs: grantedBy.map((a) => a.slug),
        restrictedFor,
        restrictedSomewhere: matchesAnyPattern(t.id, deniedPatterns),
        deniedForMe,
        blockingTeams: deniedForMe ? blockingTeamsFor(t.id) : [],
        missingCredentials,
        credentialLabel: requirement && missingCredentials.length > 0 ? requirement.label : null,
        credentialEffect: requirement && missingCredentials.length > 0 ? requirement.effect : null,
        credentialBlocking: requirement?.blocking ?? true,
        blockedForMe,
        usage: usage.byTool[t.id] ?? null,
        serverId: null,
        serverName: null,
      } satisfies CatalogTool;
    });

  /**
   * Same rules as `matchPattern` inside the registry, INCLUDING the bare `*`
   * grant that `matchesPattern` in the taxonomy does not know about. An agent
   * granted `*` holds every tool; treating that as "no grant" would have
   * reported the entire registry as unavailable.
   */
  function matchesToolPattern(toolId: string, pattern: string): boolean {
    if (pattern === '*') return true;
    return matchesPattern(toolId, pattern);
  }

  // ---------------------------------------------------------------------------
  // Tools proxied from the person's own MCP servers.
  //
  // These do NOT pass through runTool: the chat route calls them directly, so
  // they carry no risk classification, no rate limit and no team pattern. The
  // screen says so rather than borrowing a registry tool's chips for them.
  // ---------------------------------------------------------------------------
  const serverById = new Map(mcpServerRows.map((s) => [s.id, s]));
  const mcpTools: CatalogTool[] = externalServers.flatMap(({ server, tools }) => {
    const row = serverById.get(server.id);
    const trusted = Boolean((server as { trusted?: boolean }).trusted ?? row?.trusted);
    const serverName = row?.name ?? String((server as { name?: string }).name ?? 'Servidor MCP');
    return tools.map((entry) => {
      const id = `mcp:${server.id}:${entry.tool_name}`;
      return {
        id,
        kind: 'mcp',
        title: entry.tool_name,
        family: `mcp:${server.id}`,
        group: 'mcp',
        description: entry.tool_description ?? 'El servidor no describió esta herramienta.',
        needsApproval: !trusted,
        approvalReason: trusted
          ? null
          : `Marcaste "${serverName}" como no confiable, así que Cortex te pregunta antes de cada llamada.`,
        riskLevel: null,
        sensitivity: null,
        blastRadius: null,
        canLeaveCompany: false,
        outboundRiskLevel: null,
        ratePerMinute: null,
        providers: [],
        missingProviders: [],
        agents: [],
        agentSlugs: [],
        restrictedFor: [],
        restrictedSomewhere: false,
        deniedForMe: false,
        blockingTeams: [],
        missingCredentials: [],
        credentialLabel: null,
        credentialEffect: null,
        credentialBlocking: true,
        blockedForMe: [],
        usage: usage.byTool[id] ?? null,
        serverId: server.id,
        serverName,
      } satisfies CatalogTool;
    });
  });

  // ---------------------------------------------------------------------------
  // The workspace's own tools (0067).
  //
  // By the time one of these reaches the chat it IS an ordinary ToolDef, so it
  // goes through runTool and gets classified, gated, rate-limited and audited
  // like everything else — and it passes the same agent grant and team deny
  // gates. Two things differ, and both are visible here: it can be switched
  // OFF from this page, and the team permission API only validates patterns
  // against the static registry, so it gets no per-team toggle.
  // ---------------------------------------------------------------------------
  const customRows = (customToolData ?? []) as unknown as CustomToolRow[];
  const customTools: CatalogTool[] = customRows.map((row) => {
    const id = customToolId(row.slug);
    const classification = classify({
      tool: { id, requiresConfirmation: row.requires_confirmation },
      input: {},
      ctx: { now: CATALOG_CLOCK },
      surface: 'web',
    });
    const grantedBy = agents.filter((a) =>
      (a.allowed_tool_ids ?? []).some((pat) => matchesToolPattern(id, pat)),
    );
    const deniedForMe = matchesAnyPattern(id, myDenied);

    const blockedForMe: BlockReason[] = [];
    if (!row.enabled) blockedForMe.push('disabled');
    if (grantedBy.length === 0) blockedForMe.push('not_granted');
    if (deniedForMe) blockedForMe.push('team_blocked');

    return {
      id,
      kind: 'custom',
      title: row.name,
      family: 'custom',
      group: 'custom',
      description: row.description,
      needsApproval: row.requires_confirmation,
      approvalReason: row.requires_confirmation
        ? `Escribe en un sistema de la empresa (${row.http_method}), así que alguien la aprueba antes de cada ejecución.`
        : null,
      riskLevel: classification.riskLevel as RiskLevel,
      sensitivity: classification.sensitivity as Sensitivity,
      blastRadius: classification.blastRadius as BlastRadius,
      canLeaveCompany: false,
      outboundRiskLevel: null,
      ratePerMinute: row.rate_limit_per_minute,
      providers: [],
      missingProviders: [],
      agents: grantedBy.map((a) => a.name).sort(),
      agentSlugs: grantedBy.map((a) => a.slug),
      restrictedFor: isAdmin
        ? [
            ...new Set(
              deniedRows
                .filter((r) => matchesPattern(id, r.tool_pattern))
                .map((r) => teamNameById.get(r.team_id) ?? 'Equipo desconocido'),
            ),
          ].sort()
        : [],
      restrictedSomewhere: matchesAnyPattern(id, deniedPatterns),
      deniedForMe,
      blockingTeams: deniedForMe ? blockingTeamsFor(id) : [],
      missingCredentials: [],
      credentialLabel: null,
      credentialEffect: null,
      credentialBlocking: true,
      blockedForMe,
      usage: usage.byTool[id] ?? null,
      serverId: null,
      serverName: null,
      lastError: row.last_error ?? null,
      enabled: row.enabled,
    } satisfies CatalogTool;
  });

  const mcpServers: McpServerSummary[] = mcpServerRows.map((s) => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled,
    trusted: s.trusted,
    toolCount: s.tool_count ?? 0,
    lastError: s.last_error,
    lastCheckedAt: s.last_checked_at,
  }));

  const tools = [...registryTools, ...customTools, ...mcpTools];

  return (
    <>
      <PageHeader
        title="Herramientas"
        subtitle="Todo lo que Cortex sabe hacer en esta organización: qué está listo, qué está frenado y por qué, y qué se ha usado últimamente."
        icon={<Wrench className="h-5 w-5" />}
      />

      <ToolsControlCentre
        tools={tools}
        isAdmin={isAdmin}
        teams={teams}
        selectedTeamId={selectedTeamId}
        initialTeamDenied={teamDenied}
        mcpServers={mcpServers}
        agentCount={agents.length}
        usageMeta={{
          available: usage.available,
          windowDays: USAGE_WINDOW_DAYS,
          scanned: usage.scanned,
          truncated: usage.truncated,
          scanLimit: USAGE_SCAN_LIMIT,
          oldest: usage.oldest,
          distinctTools: usage.distinctTools,
        }}
      />
    </>
  );
}
