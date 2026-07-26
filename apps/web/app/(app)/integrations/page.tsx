import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import Link from 'next/link';
import { clsx } from 'clsx';
import {
  Plug,
  Mail,
  Calendar,
  Table2,
  FolderOpen,
  Building2,
  Users,
  Brain,
  Globe,
  MessageSquare,
  Github,
  ListTodo,
  Rocket,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { listTools } from '@zipdev/agent-tools';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { AddMcpServerForm } from './_components/AddMcpServerForm';
import { McpServerList, type McpServer } from './_components/McpServerList';

const MAX_MCP_SERVERS = 5;
const MAX_MCP_TOOLS = 50;

type ConnState = 'workspace' | 'user' | 'disconnected' | 'coming-soon';

interface ProviderCard {
  key: string;
  name: string;
  description: string;
  icon: typeof Mail;
  families: string[];
  state: ConnState;
  detail?: string;
  connectHref?: string;
}

const STATE_PILL: Record<ConnState, { label: string; cls: string }> = {
  workspace: { label: 'Connected · workspace', cls: 'bg-emerald-soft text-emerald' },
  user: { label: 'Connected · you', cls: 'bg-emerald-soft text-emerald' },
  disconnected: { label: 'Not connected', cls: 'bg-surface-2 text-ink-faint' },
  'coming-soon': { label: 'Coming soon', cls: 'bg-amber-soft text-amber' },
};

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const db = getSupabaseServiceClient();
  const { data: rows } = await db
    .from('integrations')
    .select('provider, scopes, expires_at, updated_at')
    .eq('user_id', user.id);

  const byProvider = Object.fromEntries((rows ?? []).map((r) => [r.provider, r]));

  // Tool counts per family, straight from the live registry.
  const toolsByFamily: Record<string, number> = {};
  for (const t of listTools()) {
    if (t.id.startsWith('test.')) continue;
    const fam = t.id.split('.')[0] ?? '';
    toolsByFamily[fam] = (toolsByFamily[fam] ?? 0) + 1;
  }
  const famCount = (families: string[]) =>
    families.reduce((sum, f) => sum + (toolsByFamily[f] ?? 0), 0);

  const googleScopes = ((byProvider.google?.scopes as string[] | undefined) ?? []).length;

  const providers: ProviderCard[] = [
    {
      key: 'google',
      name: 'Google Workspace',
      description: 'Gmail, Calendar, Sheets, Drive — granted automatically when you sign in.',
      icon: Mail,
      families: ['gmail', 'gcal', 'gsheets', 'gdrive'],
      state: byProvider.google ? 'user' : 'disconnected',
      detail: byProvider.google ? `${googleScopes} scopes granted` : 'Sign out and back in, or connect below',
      connectHref: byProvider.google ? undefined : '/api/integrations/google?preset=all',
    },
    {
      key: 'hubspot',
      name: 'HubSpot',
      description: 'Deals, companies, contacts, pipeline and activity — the sales system of record.',
      icon: Building2,
      families: ['hubspot'],
      state: process.env.HUBSPOT_PRIVATE_APP_TOKEN
        ? 'workspace'
        : byProvider.hubspot
          ? 'user'
          : 'disconnected',
      detail: process.env.HUBSPOT_PRIVATE_APP_TOKEN ? 'Private app for the whole team' : undefined,
      connectHref:
        !process.env.HUBSPOT_PRIVATE_APP_TOKEN && !byProvider.hubspot
          ? '/api/integrations/hubspot'
          : undefined,
    },
    {
      key: 'workable',
      name: 'Workable',
      description: 'The ATS ground truth: jobs, candidates, stages, questions, recent activity.',
      icon: Users,
      families: ['workable'],
      state: process.env.WORKABLE_API_TOKEN ? 'workspace' : 'disconnected',
      detail: process.env.WORKABLE_API_TOKEN ? 'Service account for the whole team' : undefined,
    },
    {
      key: 'matcher',
      name: 'Zipdev Talent Pool',
      description: 'Candidate matching, scoring, comparisons, presentations, and rate estimates.',
      icon: Sparkles,
      families: ['recruit', 'people', 'rate', 'sales'],
      state: process.env.ZIPDEV_MATCHER_URL ? 'workspace' : 'disconnected',
    },
    {
      key: 'brain',
      name: 'Zippy Brain',
      description: 'Knowledge Base search & memory, plus server-side processing with Zippy’s own model.',
      icon: Brain,
      families: ['kb', 'zippy', 'pipeline', 'schedule'],
      state: process.env.GOOGLE_GENERATIVE_AI_API_KEY ? 'workspace' : 'disconnected',
    },
    {
      key: 'web',
      name: 'Web Research',
      description: 'Live web search and page reading for prospect research and growth signals.',
      icon: Globe,
      families: ['web', 'growth'],
      state: process.env.TAVILY_API_KEY ? 'workspace' : 'disconnected',
    },
    {
      key: 'slack',
      name: 'Slack',
      description: 'Post updates and reports to team channels.',
      icon: MessageSquare,
      families: ['slack'],
      state: process.env.SLACK_BOT_TOKEN ? 'workspace' : 'disconnected',
      detail: process.env.SLACK_BOT_TOKEN ? undefined : 'Bot token not provisioned yet',
    },
    {
      key: 'github',
      name: 'GitHub',
      description: 'Repositories, issues, pull requests, and engineering activity metrics.',
      icon: Github,
      families: ['github'],
      state: byProvider.github ? 'user' : 'disconnected',
      detail: byProvider.github ? undefined : 'Provisioned by ops per user',
    },
    {
      key: 'linear',
      name: 'Linear',
      description: 'Projects, cycles, issues, and team workload for roadmap visibility.',
      icon: ListTodo,
      families: ['linear'],
      state: byProvider.linear ? 'user' : 'disconnected',
      detail: byProvider.linear ? undefined : 'Provisioned by ops per user',
    },
    {
      key: 'apollo',
      name: 'Apollo',
      description: 'Prospecting and contact enrichment for outbound — the growth pilot’s next source.',
      icon: Rocket,
      families: [],
      state: 'coming-soon',
      detail: 'Planned as the contact-identification source',
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
      authConfigured: !!row.auth_value_encrypted,
      tools: row.user_mcp_tools ?? [],
    };
  });

  const atServerCapacity = mcpServers.length >= MAX_MCP_SERVERS;
  const totalMcpTools = mcpServers.reduce((sum, s) => sum + s.tool_count, 0);
  const atToolCapacity = totalMcpTools >= MAX_MCP_TOOLS;

  const connectedCount = providers.filter((p) => p.state === 'workspace' || p.state === 'user').length;
  const totalToolCount = Object.values(toolsByFamily).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle={`${connectedCount} of ${providers.length} systems connected · ${totalToolCount} tools available to Zippy`}
        icon={<Plug className="h-5 w-5" />}
      />

      {sp.connected && (
        <div className="mb-4 rounded-[12px] border border-emerald/30 bg-emerald-soft px-3 py-2 text-[12.5px] text-emerald">
          Connected {sp.connected}.
        </div>
      )}
      {sp.error && (
        <div className="mb-4 rounded-[12px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          Error: {sp.error}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map((p) => {
          const pill = STATE_PILL[p.state];
          const tools = famCount(p.families);
          const connected = p.state === 'workspace' || p.state === 'user';
          return (
            <Panel key={p.key} className={clsx('flex h-full flex-col gap-3 p-4', !connected && 'opacity-90')}>
              <div className="flex items-start justify-between gap-2">
                <span
                  className={clsx(
                    'grid h-10 w-10 shrink-0 place-items-center rounded-[12px]',
                    connected ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink-faint',
                  )}
                >
                  <p.icon className="h-5 w-5" />
                </span>
                <span className={clsx('rounded-pill px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', pill.cls)}>
                  {pill.label}
                </span>
              </div>
              <div>
                <div className="text-[13.5px] font-bold text-ink">{p.name}</div>
                <p className="mt-0.5 text-[12px] leading-snug text-ink-muted">{p.description}</p>
                {p.detail && <p className="mt-1 text-[11px] text-ink-faint">{p.detail}</p>}
              </div>
              <div className="mt-auto flex items-center justify-between border-t border-border pt-2.5">
                <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint">
                  <Wrench className="h-3 w-3" />
                  {tools > 0 ? `${tools} tool${tools === 1 ? '' : 's'}` : '—'}
                </span>
                {p.connectHref && (
                  <Link
                    href={p.connectHref}
                    className="rounded-pill bg-primary px-3 py-1 text-[11.5px] font-bold text-white hover:bg-primary-strong"
                  >
                    Connect
                  </Link>
                )}
                {p.state === 'coming-soon' && (
                  <span className="rounded-pill bg-surface-2 px-3 py-1 text-[11.5px] font-semibold text-ink-faint">
                    Not available yet
                  </span>
                )}
              </div>
            </Panel>
          );
        })}
      </div>

      <Panel className="mt-5 p-5">
        <header className="mb-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            External MCP servers
          </div>
          <p className="mt-1 text-[12.5px] text-ink-muted">
            Connect your own Model Context Protocol servers (Notion, self-hosted, …). Their tools
            become available to Zippy. Max {MAX_MCP_SERVERS} servers, {MAX_MCP_TOOLS} tools total.
          </p>
        </header>

        <McpServerList servers={mcpServers} />

        {atServerCapacity && (
          <p className="mt-4 rounded-[12px] border border-amber/30 bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
            Max {MAX_MCP_SERVERS} servers reached. Delete one to add another.
          </p>
        )}
        {atToolCapacity && (
          <p className="mt-2 rounded-[12px] border border-amber/30 bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
            50-tool total limit reached. New tools will not be synced until you remove some.
          </p>
        )}

        {!atServerCapacity && (
          <div className="mt-4 border-t border-border pt-4">
            <h3 className="text-[12.5px] font-semibold text-ink">Add a server</h3>
            <AddMcpServerForm disabled={atServerCapacity} />
          </div>
        )}
      </Panel>
    </>
  );
}
