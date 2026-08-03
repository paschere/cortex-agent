import { DirectionPair } from '@/components/connect/DirectionPair';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { listTools } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  Boxes,
  Brain,
  Building2,
  CircleCheck,
  Contact,
  GitBranch,
  Globe,
  ListTodo,
  Mail,
  MessageSquare,
  Plug,
  Rocket,
  Server,
  Sparkles,
  TriangleAlert,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { AddMcpServerForm } from './_components/AddMcpServerForm';
import { type McpServer, McpServerList } from './_components/McpServerList';

const MAX_MCP_SERVERS = 5;
const MAX_MCP_TOOLS = 50;

/** Connected for the whole team, connected by this person, or not at all. */
type ConnState = 'workspace' | 'user' | 'disconnected';

interface ProviderCard {
  key: string;
  name: string;
  icon: typeof Mail;
  /** Tool families this system backs — drives the live tool count. */
  families: string[];
  state: ConnState;
  /** Plain language: what Cortex can do because this is connected. */
  unlocks: string;
  /** Plain language: what stops working while it is disconnected. */
  offline: string;
  /** Who turned it on — or who would have to. */
  owner: string;
  connectHref?: string;
}

const STATE_PILL: Record<ConnState, { label: string; cls: string }> = {
  workspace: { label: 'Connected · team', cls: 'bg-emerald-soft text-emerald' },
  user: { label: 'Connected · you', cls: 'bg-emerald-soft text-emerald' },
  disconnected: { label: 'Not connected', cls: 'bg-surface-2 text-ink-faint' },
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const db = getSupabaseServiceClient();

  // Every OAuth row, not just this user's: "who connected it" is part of the
  // answer, and a team-sized table makes this a cheap read.
  const { data: integrationRows } = await db
    .from('integrations')
    .select('provider, scopes, updated_at, user_id')
    .limit(1000);

  const rows = (integrationRows ?? []) as Array<{
    provider: string;
    scopes: string[] | null;
    updated_at: string | null;
    user_id: string;
  }>;

  const mine: Record<string, (typeof rows)[number]> = {};
  const teammates: Record<string, number> = {};
  for (const r of rows) {
    if (r.user_id === user.id) mine[r.provider] = r;
    else teammates[r.provider] = (teammates[r.provider] ?? 0) + 1;
  }

  /** Owner line for a per-user OAuth provider. */
  function personalOwner(provider: string): string {
    const own = mine[provider];
    if (own) {
      const when = fmtDate(own.updated_at);
      return when ? `Connected by you · ${when}` : 'Connected by you';
    }
    const n = teammates[provider] ?? 0;
    if (n > 0) {
      return `${n} teammate${n === 1 ? '' : 's'} connected it — your account has not`;
    }
    return 'Nobody has connected this yet';
  }

  /** Owner line for a workspace credential provisioned by ops. */
  function opsOwner(connected: boolean, what: string): string {
    return connected ? 'Set up by ops · shared by the whole team' : `Waiting on ops — ${what}`;
  }

  // Tool counts per family, straight from the live registry.
  const toolsByFamily: Record<string, number> = {};
  for (const t of listTools()) {
    if (t.id.startsWith('test.')) continue;
    const fam = t.id.split('.')[0] ?? '';
    toolsByFamily[fam] = (toolsByFamily[fam] ?? 0) + 1;
  }
  const famCount = (families: string[]) =>
    families.reduce((sum, f) => sum + (toolsByFamily[f] ?? 0), 0);

  const googleScopes = (mine.google?.scopes ?? []).length;
  const hubspotWorkspace = !!process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const workableOn = !!process.env.WORKABLE_API_TOKEN;
  const matcherOn = !!process.env.ZIPDEV_MATCHER_URL;
  const payrollOn = !!process.env.PAYROLL_API_URL;
  const brainOn = !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  const webOn = !!process.env.TAVILY_API_KEY;
  const slackOn = !!process.env.SLACK_BOT_TOKEN;
  const apolloOn = !!process.env.APOLLO_API_KEY;
  const bambooOn = !!process.env.BAMBOOHR_API;

  const providers: ProviderCard[] = [
    {
      key: 'google',
      name: 'Google Workspace',
      icon: Mail,
      families: ['gmail', 'gcal', 'gsheets', 'gdrive', 'meetings', 'chat'],
      state: mine.google ? 'user' : 'disconnected',
      unlocks:
        'Read and draft your email, see and create calendar events, open Docs, Sheets and Drive files, and pull meeting transcripts.',
      offline:
        'No inbox, no calendar, no Drive and no meeting notes — Cortex cannot see your day at all.',
      owner: mine.google
        ? `Connected by you${googleScopes ? ` · ${googleScopes} scopes granted` : ''}`
        : 'Granted when you sign in — connect below if it was skipped',
      connectHref: mine.google ? undefined : '/api/integrations/google?preset=all',
    },
    {
      key: 'hubspot',
      name: 'HubSpot',
      icon: Building2,
      families: ['hubspot'],
      state: hubspotWorkspace ? 'workspace' : mine.hubspot ? 'user' : 'disconnected',
      unlocks:
        'Deals, companies, contacts, pipeline health and recent activity — the sales system of record.',
      offline: 'No deal, pipeline or contact answers — the whole sales side goes dark.',
      owner: hubspotWorkspace
        ? 'Set up by ops · one private app for the whole team'
        : personalOwner('hubspot'),
      connectHref: !hubspotWorkspace && !mine.hubspot ? '/api/integrations/hubspot' : undefined,
    },
    {
      key: 'workable',
      name: 'Workable',
      icon: Users,
      families: ['workable'],
      state: workableOn ? 'workspace' : 'disconnected',
      unlocks:
        'The ATS ground truth: jobs, candidates, stages, screening answers and recent activity.',
      offline: 'Cortex cannot see any real job or candidate — it would be guessing about pipeline.',
      owner: opsOwner(workableOn, 'no Workable service token on this environment'),
    },
    {
      key: 'matcher',
      name: 'Zipdev Talent Pool',
      icon: Sparkles,
      families: ['recruit', 'people', 'rate', 'presentations', 'sales'],
      state: matcherOn ? 'workspace' : 'disconnected',
      unlocks:
        'Candidate matching and scoring, side-by-side comparisons, client presentations and rate estimates.',
      offline: 'No matching, no scoring, no presentations and no rate estimates.',
      owner: opsOwner(matcherOn, 'the matcher service URL is not configured'),
    },
    {
      key: 'bamboo',
      name: 'BambooHR',
      icon: Contact,
      families: ['bamboo'],
      state: bambooOn ? 'workspace' : 'disconnected',
      unlocks:
        'The HR system of record: the roster, job and employment history, time off, hours logged, documents on file, and both the pay rate Zipdev pays and the bill rate it charges the client.',
      offline:
        'Cortex cannot see who actually works here — no roster, no time off, no tenure and no rates.',
      owner: opsOwner(bambooOn, 'no BambooHR API key on this environment'),
    },
    {
      key: 'payroll',
      name: 'Payroll',
      icon: Wallet,
      families: ['payroll'],
      state: payrollOn ? 'workspace' : 'disconnected',
      unlocks:
        'Who is assigned to which client, payroll and expense reports, and forward-looking cost projections.',
      offline: 'No team cost, assignment or expense answers.',
      owner: opsOwner(payrollOn, 'no payroll API URL on this environment'),
    },
    {
      key: 'brain',
      name: 'Cortex Brain',
      icon: Brain,
      families: ['kb', 'pipeline', 'schedule', 'inbox', 'security'],
      state: brainOn ? 'workspace' : 'disconnected',
      unlocks:
        'Knowledge Base search and memory, pipelines, routines and the inbox digest — Cortex’s own reasoning.',
      offline: 'The core stops: no Knowledge Base, no pipelines, no routines.',
      owner: opsOwner(brainOn, 'the model API key is missing'),
    },
    {
      key: 'web',
      name: 'Web Research',
      icon: Globe,
      families: ['web', 'growth'],
      state: webOn ? 'workspace' : 'disconnected',
      unlocks: 'Live web search and page reading for prospect research and growth signals.',
      offline: 'Cortex is limited to what it already knows — no fresh research on companies.',
      owner: opsOwner(webOn, 'no search API key on this environment'),
    },
    {
      key: 'slack',
      name: 'Slack',
      icon: MessageSquare,
      families: ['slack'],
      state: slackOn ? 'workspace' : 'disconnected',
      unlocks: 'Post updates, reports and routine results straight into team channels.',
      offline: 'Results stay in the app and in email — nothing reaches Slack.',
      owner: opsOwner(slackOn, 'the bot token is not provisioned yet'),
    },
    {
      key: 'github',
      name: 'GitHub',
      icon: GitBranch,
      families: ['github'],
      state: mine.github ? 'user' : 'disconnected',
      unlocks: 'Repositories, issues, pull requests and engineering activity metrics.',
      offline: 'No repo, issue or PR visibility — engineering questions go unanswered.',
      owner: mine.github
        ? personalOwner('github')
        : `${personalOwner('github')} · ops provisions it`,
    },
    {
      key: 'linear',
      name: 'Linear',
      icon: ListTodo,
      families: ['linear'],
      state: mine.linear ? 'user' : 'disconnected',
      unlocks: 'Projects, cycles, issues and team workload for roadmap visibility.',
      offline: 'No roadmap or workload answers — Cortex cannot see what the team is building.',
      owner: mine.linear
        ? personalOwner('linear')
        : `${personalOwner('linear')} · ops provisions it`,
    },
    {
      key: 'apollo',
      name: 'Apollo',
      icon: Rocket,
      families: ['apollo'],
      state: apolloOn ? 'workspace' : 'disconnected',
      unlocks:
        'Prospecting and contact enrichment for outbound — who works where, their verified work email, and firmographics on the companies worth targeting.',
      offline: 'Growth signals stop at the company: Cortex cannot identify the person to contact.',
      owner: opsOwner(apolloOn, 'no Apollo API key on this environment'),
    },
  ];

  const { data: mcpRows } = await db
    .from('user_mcp_servers')
    .select(
      'id, name, url, auth_type, auth_value_encrypted, enabled, trusted, tool_count, last_checked_at, last_error, user_mcp_tools(tool_name, tool_description)',
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  const mcpServers: McpServer[] = (mcpRows ?? []).map((r) => {
    const row = r as Record<string, unknown> & {
      auth_value_encrypted: string | null;
      user_mcp_tools?: Array<{ tool_name: string; tool_description: string | null }>;
    };
    return {
      id: row.id as string,
      name: row.name as string,
      url: row.url as string,
      auth_type: row.auth_type as McpServer['auth_type'],
      enabled: row.enabled as boolean,
      trusted: row.trusted as boolean,
      tool_count: (row.tool_count as number) ?? 0,
      last_checked_at: (row.last_checked_at as string | null) ?? null,
      last_error: (row.last_error as string | null) ?? null,
      // Never the secret itself — only whether one is stored.
      authConfigured: !!row.auth_value_encrypted,
      tools: row.user_mcp_tools ?? [],
    };
  });

  const atServerCapacity = mcpServers.length >= MAX_MCP_SERVERS;
  const totalMcpTools = mcpServers.reduce((sum, s) => sum + s.tool_count, 0);
  const atToolCapacity = totalMcpTools >= MAX_MCP_TOOLS;

  const connected = providers.filter((p) => p.state !== 'disconnected');
  const missing = providers.filter((p) => p.state === 'disconnected');
  const totalToolCount = Object.values(toolsByFamily).reduce((a, b) => a + b, 0);

  const stats = [
    {
      label: 'Systems connected',
      value: `${connected.length}/${providers.length}`,
      sub: 'Cortex can act in these',
      icon: CircleCheck,
      tone: 'emerald' as const,
    },
    {
      label: 'Not connected',
      value: String(missing.length),
      sub: missing.length > 0 ? missing.map((p) => p.name).join(', ') : 'nothing missing',
      icon: TriangleAlert,
      tone: missing.length > 0 ? ('amber' as const) : ('emerald' as const),
    },
    {
      label: 'Built-in tools',
      value: String(totalToolCount),
      sub: 'available to Cortex',
      icon: Wrench,
      tone: 'primary' as const,
    },
    {
      label: 'Tools you plugged in',
      value: String(totalMcpTools),
      sub: `${mcpServers.length} external MCP server${mcpServers.length === 1 ? '' : 's'}`,
      icon: Boxes,
      tone: 'primary' as const,
    },
  ];

  const TONE: Record<'primary' | 'emerald' | 'amber', string> = {
    primary: 'bg-primary-soft text-primary',
    emerald: 'bg-emerald-soft text-emerald',
    amber: 'bg-amber-soft text-amber',
  };

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="What Cortex is connected to — the systems it can read and act in on your behalf."
        icon={<Plug className="h-5 w-5" />}
      />

      <DirectionPair active="outbound" />

      {sp.connected && (
        <div className="mb-4 rounded-card border border-emerald/30 bg-emerald-soft px-3 py-2 text-[12.5px] text-emerald">
          Connected {sp.connected}.
        </div>
      )}
      {sp.error && (
        <div className="mb-4 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          Error: {sp.error}
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Panel key={s.label} className="flex items-center gap-3 p-3.5">
            <span
              className={clsx(
                'grid h-9 w-9 shrink-0 place-items-center rounded-[10px]',
                TONE[s.tone],
              )}
            >
              <s.icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-[15px] font-extrabold leading-tight text-ink">
                {s.value}
              </div>
              <div className="truncate text-[10.5px] text-ink-faint">{s.label}</div>
              <div className="truncate text-[10.5px] text-ink-faint" title={s.sub}>
                {s.sub}
              </div>
            </div>
          </Panel>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {providers.map((p) => {
          const pill = STATE_PILL[p.state];
          const tools = famCount(p.families);
          const isOn = p.state !== 'disconnected';
          return (
            <Panel key={p.key} className="flex h-full flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <span
                  className={clsx(
                    'grid h-10 w-10 shrink-0 place-items-center rounded-[12px]',
                    isOn ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink-faint',
                  )}
                >
                  <p.icon className="h-5 w-5" />
                </span>
                <span
                  className={clsx(
                    'rounded-pill px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                    pill.cls,
                  )}
                >
                  {pill.label}
                </span>
              </div>

              <div>
                <div className="text-[13.5px] font-bold text-ink">{p.name}</div>
                <p className="mt-0.5 text-[12px] leading-snug text-ink-muted">{p.unlocks}</p>
              </div>

              <p className="flex items-start gap-1.5 text-[11px] leading-snug text-ink-faint">
                <Users className="mt-px h-3 w-3 shrink-0" />
                {p.owner}
              </p>

              {!isOn && (
                <p className="flex items-start gap-1.5 rounded-[10px] bg-amber-soft px-2.5 py-1.5 text-[11px] leading-snug text-amber">
                  <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
                  <span>
                    <span className="font-semibold">While it is off: </span>
                    {p.offline}
                  </span>
                </p>
              )}

              <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2.5">
                <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint">
                  <Wrench className="h-3 w-3" />
                  {tools > 0 ? `${tools} tool${tools === 1 ? '' : 's'}` : 'no tools yet'}
                </span>
                {p.connectHref && (
                  <Link
                    href={p.connectHref}
                    className="rounded-pill bg-primary px-3 py-1 text-[11.5px] font-bold text-white hover:bg-primary-strong"
                  >
                    Connect
                  </Link>
                )}
              </div>
            </Panel>
          );
        })}
      </div>

      {/* Advanced: external MCP servers are just another inbound source of
          tools — same direction as an integration, so they live here. */}
      <Panel className="mt-5 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-surface-2 text-ink-muted">
            <Server className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Advanced
            </div>
            <h2 className="mt-0.5 text-[15px] font-bold tracking-tight text-ink">
              Extra tools you plug into Cortex
            </h2>
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
              Point Cortex at your own Model Context Protocol server — Notion, a vendor’s hosted
              server, something you self-host — and its tools join the list above for your account
              only. Most people never need this.
            </p>
            <p className="mt-1 text-[11.5px] text-ink-faint">
              Up to {MAX_MCP_SERVERS} servers and {MAX_MCP_TOOLS} tools in total. Looking for how to
              use Cortex <em>from</em> Claude instead?{' '}
              <Link href="/mcp-tokens" className="font-semibold text-primary hover:underline">
                That is the other page
              </Link>
              .
            </p>
          </div>
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <McpServerList servers={mcpServers} />

          {atServerCapacity && (
            <p className="mt-4 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
              Max {MAX_MCP_SERVERS} servers reached. Delete one to add another.
            </p>
          )}
          {atToolCapacity && (
            <p className="mt-2 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
              {MAX_MCP_TOOLS}-tool total limit reached. New tools will not be synced until you
              remove some.
            </p>
          )}

          {!atServerCapacity && (
            <div className="mt-4 border-t border-border pt-4">
              <h3 className="text-[12.5px] font-semibold text-ink">Add a server</h3>
              <AddMcpServerForm disabled={atServerCapacity} />
            </div>
          )}
        </div>
      </Panel>
    </>
  );
}
