import Link from 'next/link';
import {
  MessagesSquare,
  Bot,
  Wrench,
  Gauge,
  Send,
  Users2,
  GitBranch,
  Sparkles,
  Activity,
  ArrowRight,
  BookOpen,
} from 'lucide-react';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelHead, StatCard, ProgressRow, IconChip } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { toolLabel } from '@/lib/tool-labels';

export const dynamic = 'force-dynamic';

interface AuditRow {
  tool_id: string;
  status: string;
  latency_ms: number | null;
  created_at: string;
  user_id: string;
}

const TONES = ['primary', 'emerald', 'amber', 'sky', 'rose'] as const;

export default async function DashboardPage() {
  const user = await requireSession();
  const sb = getSupabaseServiceClient();
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [convCount, agentCount, kbDocs, auditRes, recentConvRes, usersRes] = await Promise.all([
    sb.from('conversations').select('id', { count: 'exact', head: true }),
    sb.from('agents').select('id', { count: 'exact', head: true }),
    sb.from('kb_documents').select('id', { count: 'exact', head: true }),
    sb
      .from('audit_events')
      .select('tool_id, status, latency_ms, created_at, user_id')
      .gte('created_at', since)
      .order('created_at', { ascending: false }),
    sb
      .from('conversations')
      .select('id, title, updated_at, user_id, agents(name)')
      .order('updated_at', { ascending: false })
      .limit(6),
    sb.from('users').select('id, name, email'),
  ]);

  const audit = (auditRes.data ?? []) as AuditRow[];
  const totalConversations = convCount.count ?? 0;
  const totalAgents = agentCount.count ?? 0;
  const totalDocs = kbDocs.count ?? 0;

  // Separate real tool calls from synthetic agent-turn markers.
  const toolCalls = audit.filter((a) => a.tool_id !== '__agent_turn');
  const okCount = toolCalls.filter((a) => a.status === 'ok').length;
  const errCount = toolCalls.filter((a) => a.status === 'error').length;
  const pendingCount = toolCalls.filter((a) => a.status === 'confirmation_required').length;
  const rateLimited = toolCalls.filter((a) => a.status === 'rate_limited').length;
  const totalCalls = toolCalls.length;
  const successRate = totalCalls > 0 ? Math.round((okCount / totalCalls) * 100) : 0;
  const agentTurns = audit.filter((a) => a.tool_id === '__agent_turn').length;

  const latencies = toolCalls.map((a) => a.latency_ms ?? 0).filter((n) => n > 0);
  const avgLatency =
    latencies.length > 0 ? Math.round(latencies.reduce((s, n) => s + n, 0) / latencies.length) : 0;

  // Tool usage breakdown (top 5).
  const byTool: Record<string, number> = {};
  for (const a of toolCalls) byTool[a.tool_id] = (byTool[a.tool_id] ?? 0) + 1;
  const topTools = Object.entries(byTool)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topToolMax = topTools.length > 0 ? Math.max(...topTools.map(([, n]) => n)) : 0;

  // Per-user activity (team workload).
  const byUser: Record<string, number> = {};
  for (const a of audit) byUser[a.user_id] = (byUser[a.user_id] ?? 0) + 1;
  const userMap = new Map(
    ((usersRes.data ?? []) as { id: string; name: string | null; email: string }[]).map((u) => [
      u.id,
      u.name?.trim() || u.email,
    ]),
  );
  const teamRows = Object.entries(byUser)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const teamMax = teamRows.length > 0 ? Math.max(...teamRows.map(([, n]) => n)) : 0;

  const recentConvs = (recentConvRes.data ?? []) as {
    id: string;
    title: string | null;
    updated_at: string;
    agents: { name: string } | { name: string }[] | null;
  }[];

  const heroTotal = totalCalls + agentTurns;

  return (
    <>
      <PageHeader
        title="Sales Co-pilot"
        subtitle="Workspace overview · last 7 days"
        icon={<Sparkles className="h-5 w-5" />}
        actions={
          <Link
            href="/chat"
            className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-[13px] font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong"
          >
            New chat
            <ArrowRight className="h-4 w-4" />
          </Link>
        }
      />

      {/* KPI row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Conversations"
          value={totalConversations.toLocaleString()}
          sub={`${agentTurns} agent turns this week`}
          icon={<MessagesSquare className="h-[18px] w-[18px]" />}
          tone="primary"
          delay={0}
        />
        <StatCard
          label="Active Agents"
          value={String(totalAgents)}
          sub="Sales co-pilot online"
          icon={<Bot className="h-[18px] w-[18px]" />}
          tone="sky"
          delay={60}
        />
        <StatCard
          label="Tool Calls"
          value={totalCalls.toLocaleString()}
          sub={`${okCount} succeeded · ${errCount} failed`}
          icon={<Wrench className="h-[18px] w-[18px]" />}
          tone="amber"
          delay={120}
        />
        <StatCard
          label="Success Rate"
          value={`${successRate}%`}
          sub={totalCalls > 0 ? `${okCount}/${totalCalls} ok` : 'No calls yet'}
          icon={<Gauge className="h-[18px] w-[18px]" />}
          tone="emerald"
          delay={180}
        />
      </div>

      {/* Hero — gradient activity banner */}
      <div className="hero-mesh animate-rise mt-4 overflow-hidden rounded-card p-6 text-white shadow-pop" style={{ animationDelay: '120ms' }}>
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-[14px] bg-white/15 backdrop-blur">
              <Send className="h-5 w-5" />
            </span>
            <div>
              <div className="text-lg font-bold leading-tight">Agent Activity</div>
              <div className="text-[13px] text-white/70">{heroTotal} actions executed this week</div>
            </div>
          </div>
          <div className="flex items-center gap-8">
            {[
              { n: heroTotal, l: 'Total' },
              { n: pendingCount, l: 'Pending' },
              { n: okCount, l: 'Succeeded' },
              { n: errCount + rateLimited, l: 'Blocked' },
            ].map((m) => (
              <div key={m.l} className="text-center">
                <div className="stat-num text-3xl">{m.n}</div>
                <div className="text-[11px] uppercase tracking-wider text-white/60">{m.l}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Middle row: Team Workload + Tool Pipeline */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel className="pb-5">
          <PanelHead icon={<Users2 className="h-4 w-4" />} title="Team Workload" right={`${teamRows.length} active`} />
          <div className="mt-4 space-y-4 px-5">
            {teamRows.length === 0 ? (
              <EmptyHint>No activity recorded this week.</EmptyHint>
            ) : (
              teamRows.map(([uid, n], i) => (
                <ProgressRow
                  key={uid}
                  label={userMap.get(uid) ?? 'Unknown user'}
                  value={n}
                  total={teamMax}
                  tone={TONES[i % TONES.length]}
                />
              ))
            )}
          </div>
        </Panel>

        <Panel className="pb-5">
          <PanelHead icon={<GitBranch className="h-4 w-4" />} title="Tool Pipeline" right={`${totalCalls} calls`} />
          <div className="mt-4 space-y-4 px-5">
            {topTools.length === 0 ? (
              <EmptyHint>No tools have run yet. Start a chat to see activity.</EmptyHint>
            ) : (
              topTools.map(([tool, n], i) => (
                <ProgressRow
                  key={tool}
                  label={toolLabel(tool.replaceAll('.', '_')).label}
                  value={n}
                  total={topToolMax}
                  tone={TONES[i % TONES.length]}
                />
              ))
            )}
          </div>
        </Panel>
      </div>

      {/* Bottom row: AI Performance + Recent Activity */}
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel className="pb-5">
          <PanelHead icon={<Gauge className="h-4 w-4" />} title="AI Performance" />
          <div className="mt-4 space-y-4 px-5">
            <Metric label="Success Rate" value={`${successRate}%`} bar={successRate} tone="emerald" />
            <Metric
              label="Confirmation Gate"
              value={totalCalls > 0 ? `${Math.round((pendingCount / totalCalls) * 100)}%` : '0%'}
              bar={totalCalls > 0 ? Math.round((pendingCount / totalCalls) * 100) : 0}
              tone="primary"
            />
            <div className="flex items-center justify-between border-t border-border pt-3 text-[13px]">
              <span className="text-ink-muted">Avg processing</span>
              <span className="stat-num text-ink">{avgLatency > 0 ? `${avgLatency} ms` : '—'}</span>
            </div>
            <div className="flex items-center justify-between text-[13px]">
              <span className="text-ink-muted">KB documents</span>
              <span className="stat-num text-ink">{totalDocs}</span>
            </div>
          </div>
        </Panel>

        <Panel className="pb-3">
          <PanelHead icon={<Activity className="h-4 w-4" />} title="Recent Activity" />
          <div className="mt-2 px-3">
            {recentConvs.length === 0 ? (
              <div className="px-2 py-6">
                <EmptyHint>No conversations yet.</EmptyHint>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {recentConvs.map((c) => {
                  const agentName = Array.isArray(c.agents) ? c.agents[0]?.name : c.agents?.name;
                  return (
                    <li key={c.id}>
                      <Link
                        href={`/chat/${c.id}`}
                        className="flex items-center gap-3 rounded-[10px] px-2 py-2.5 transition-colors hover:bg-surface-2"
                      >
                        <IconChip tone="primary">
                          <MessagesSquare className="h-4 w-4" />
                        </IconChip>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-medium text-ink">
                            {c.title?.trim() || 'Untitled conversation'}
                          </div>
                          <div className="truncate text-xs text-ink-faint">{agentName ?? 'Sales'}</div>
                        </div>
                        <span className="shrink-0 text-xs text-ink-faint">{relativeTime(c.updated_at)}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="px-5 pb-2 pt-2">
            <Link
              href="/conversations"
              className="inline-flex items-center gap-1 text-[13px] font-semibold text-primary hover:text-primary-strong"
            >
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </Panel>
      </div>

      {/* Quick links */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <QuickLink href="/kb" icon={<BookOpen className="h-[18px] w-[18px]" />} title="Knowledge Base" sub={`${totalDocs} documents indexed`} tone="sky" />
        <QuickLink href="/integrations" icon={<Wrench className="h-[18px] w-[18px]" />} title="Integrations" sub="HubSpot · Google · MCP" tone="amber" />
        <QuickLink href="/agents" icon={<Bot className="h-[18px] w-[18px]" />} title="Agents" sub={`${totalAgents} configured`} tone="primary" />
      </div>
    </>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-center text-[13px] text-ink-faint">{children}</p>;
}

function Metric({
  label,
  value,
  bar,
  tone,
}: {
  label: string;
  value: string;
  bar: number;
  tone: 'primary' | 'emerald';
}) {
  const color = tone === 'emerald' ? 'bg-emerald' : 'bg-primary';
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[13px]">
        <span className="text-ink-muted">{label}</span>
        <span className="stat-num text-ink">{value}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div className={`h-full rounded-full ${color} transition-[width] duration-700`} style={{ width: `${Math.min(bar, 100)}%` }} />
      </div>
    </div>
  );
}

function QuickLink({
  href,
  icon,
  title,
  sub,
  tone,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  sub: string;
  tone: 'primary' | 'sky' | 'amber';
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-card border border-border bg-surface p-4 shadow-card transition-colors hover:border-primary/30"
    >
      <IconChip tone={tone}>{icon}</IconChip>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-ink">{title}</div>
        <div className="truncate text-xs text-ink-faint">{sub}</div>
      </div>
      <ArrowRight className="h-4 w-4 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
    </Link>
  );
}
