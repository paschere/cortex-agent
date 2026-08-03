import { CopyButton } from '@/components/connect/ConnectCortex';
import { Panel } from '@/components/ui/panel';
import { getMcpUrl } from '@/lib/mcp-url';
import { relativeTime } from '@/lib/relative-time';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { clsx } from 'clsx';
import {
  AlarmClock,
  ArrowRight,
  BadgeCheck,
  BookOpen,
  MessagesSquare,
  Plug,
  Radar,
  ScrollText,
  ShieldCheck,
  Sparkles,
  Workflow,
  Wrench,
  Zap,
} from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface RunRow {
  id: string;
  status: string;
  started_at: string;
  output: string | null;
  error: string | null;
  scheduled_jobs: { name: string } | { name: string }[] | null;
}

interface ConversationRow {
  id: string;
  title: string | null;
  updated_at: string;
  agents: { name: string } | { name: string }[] | null;
}

function relName(rel: { name: string } | { name: string }[] | null): string | undefined {
  return Array.isArray(rel) ? rel[0]?.name : rel?.name;
}

export default async function DashboardPage() {
  const user = await requireSession();
  const sb = getSupabaseServiceClient();

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const nowIso = new Date().toISOString();

  const [toolCallsRes, signalsRes, approvalsRes, routinesRes, runsRes, convsRes] =
    await Promise.all([
      sb
        .from('audit_events')
        .select('id', { count: 'exact', head: true })
        // Both are bookkeeping rows, not tool calls: counting them would make
        // approving something look like running two things.
        .not('tool_id', 'in', '("__agent_turn","__approval_decision")')
        .gte('created_at', todayStart.toISOString()),
      sb.from('growth_signals').select('id', { count: 'exact', head: true }).eq('status', 'new'),
      sb
        .from('mcp_pending_actions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .is('decision', null)
        .gt('expires_at', nowIso),
      sb
        .from('scheduled_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .eq('status', 'active'),
      sb
        .from('scheduled_job_runs')
        .select('id, status, started_at, output, error, scheduled_jobs!inner(name, user_id)')
        .eq('scheduled_jobs.user_id', user.id)
        .order('started_at', { ascending: false })
        .limit(6),
      sb
        .from('conversations')
        .select('id, title, updated_at, agents(name)')
        .eq('user_id', user.id)
        .neq('surface', 'mcp')
        .order('updated_at', { ascending: false })
        .limit(5),
    ]);

  const toolCallsToday = toolCallsRes.count ?? 0;
  const newSignals = signalsRes.count ?? 0;
  const pendingApprovals = approvalsRes.count ?? 0;
  const activeRoutines = routinesRes.count ?? 0;

  const runs = (runsRes.data ?? []) as unknown as RunRow[];
  const conversations = (convsRes.data ?? []) as unknown as ConversationRow[];

  const firstName = (user.name?.trim() || user.email.split('@')[0] || 'hola').split(/\s+/)[0];
  const needsYou = pendingApprovals + newSignals;

  const mcpUrl = await getMcpUrl();
  const isAdmin = user.role === 'org_admin';

  return (
    <>
      {/* Greeting hero */}
      <Panel className="animate-rise mb-4 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div className="flex items-center gap-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-[14px] bg-gradient-to-br from-primary to-primary-strong text-white shadow-pop">
              <Zap className="h-6 w-6" />
            </span>
            <div>
              <h1 className="text-[22px] font-extrabold tracking-tight text-ink">
                Hi, {firstName}
              </h1>
              <p className="mt-0.5 text-[13px] text-ink-muted">
                Here is what happened while you were away ⚡
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatChip
              icon={<Wrench className="h-3.5 w-3.5" />}
              value={toolCallsToday}
              label="tool calls today"
            />
            <StatChip
              icon={<Radar className="h-3.5 w-3.5" />}
              value={newSignals}
              label="new signals"
              tone={newSignals > 0 ? 'amber' : 'default'}
            />
            <StatChip
              icon={<BadgeCheck className="h-3.5 w-3.5" />}
              value={pendingApprovals}
              label="to approve"
              tone={pendingApprovals > 0 ? 'amber' : 'default'}
            />
            <StatChip
              icon={<AlarmClock className="h-3.5 w-3.5" />}
              value={activeRoutines}
              label="active routines"
            />
          </div>
        </div>
      </Panel>

      {/* Needs you */}
      {needsYou > 0 && (
        <Link
          href="/approvals"
          className="group mb-4 flex items-center gap-3 rounded-card border border-amber/40 bg-amber-soft px-4 py-3 shadow-card transition-colors hover:border-amber/70"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-amber text-white">
            <BadgeCheck className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1 text-[13px]">
            <span className="font-semibold text-ink">Cortex needs you</span>
            <span className="text-ink-muted">
              {' '}
              —{' '}
              {pendingApprovals > 0 &&
                `${pendingApprovals} action${pendingApprovals === 1 ? '' : 's'} awaiting your OK`}
              {pendingApprovals > 0 && newSignals > 0 && ' · '}
              {newSignals > 0 &&
                `${newSignals} growth signal${newSignals === 1 ? '' : 's'} to review`}
            </span>
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-amber transition-transform group-hover:translate-x-0.5" />
        </Link>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Latest routine runs */}
        <Panel className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Routines — latest runs
            </div>
            <Link
              href="/schedules"
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary-strong"
            >
              View routines <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {runs.length === 0 ? (
            <EmptyHint>No routine has run yet. Ask Cortex for one in the chat.</EmptyHint>
          ) : (
            <ul className="divide-y divide-border">
              {runs.map((r) => {
                const excerpt = (r.status === 'error' ? r.error : r.output)?.trim();
                return (
                  <li key={r.id} className="py-2.5 first:pt-0 last:pb-0">
                    <div className="flex items-center gap-2">
                      <StatusPill status={r.status} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                        {relName(r.scheduled_jobs) ?? 'Rutina'}
                      </span>
                      <span className="shrink-0 text-xs text-ink-faint">
                        {relativeTime(r.started_at)}
                      </span>
                    </div>
                    {excerpt && (
                      <p
                        className={clsx(
                          'mt-1 line-clamp-2 text-[12px] leading-snug',
                          r.status === 'error' ? 'text-rose' : 'text-ink-muted',
                        )}
                      >
                        {excerpt}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {/* Recent conversations */}
        <Panel className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
              Recent conversations
            </div>
            <Link
              href="/chat"
              className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary-strong"
            >
              New chat <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {conversations.length === 0 ? (
            <EmptyHint>No conversations yet. Start one with Cortex.</EmptyHint>
          ) : (
            <ul className="divide-y divide-border">
              {conversations.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/chat/${c.id}`}
                    className="flex items-center gap-3 rounded-[10px] px-1.5 py-2.5 transition-colors hover:bg-surface-2"
                  >
                    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
                      <MessagesSquare className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-ink">
                        {c.title?.trim() || 'Untitled conversation'}
                      </div>
                      <div className="truncate text-xs text-ink-faint">
                        {relName(c.agents) ?? 'Cortex'}
                      </div>
                    </div>
                    <span className="shrink-0 text-xs text-ink-faint">
                      {relativeTime(c.updated_at)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {/* Quick actions */}
      <div className="mt-4">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
          Quick actions
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <QuickAction href="/chat" icon={<Sparkles className="h-4 w-4" />} label="New chat" />
          <QuickAction
            href="/pipelines"
            icon={<Workflow className="h-4 w-4" />}
            label="Run a pipeline"
          />
          <QuickAction
            href="/kb"
            icon={<BookOpen className="h-4 w-4" />}
            label="Search the brain"
          />
          <QuickAction
            href="/schedules"
            icon={<AlarmClock className="h-4 w-4" />}
            label="Routines"
          />
        </div>
      </div>

      {/* Connect Cortex anywhere — the connector URL lives here because it is the
          one thing people come back for; the per-client walkthrough lives on
          /mcp-tokens so the two surfaces cannot drift apart. */}
      <Panel className="mt-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[11px] bg-primary-soft text-primary">
              <Plug className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] font-bold tracking-tight text-ink">
                Connect Cortex anywhere
              </h2>
              <p className="mt-0.5 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
                The same brain — every tool, the Knowledge Base, pipelines and routines — inside
                Claude, Claude Code, ChatGPT or any MCP client. It runs with your own permissions
                and every action stays audited.
              </p>
            </div>
          </div>
          <Link
            href="/mcp-tokens"
            className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-primary px-3.5 py-2 text-[12.5px] font-bold text-white shadow-pop transition-colors hover:bg-primary-strong"
          >
            Set up a client
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="mt-4">
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
            Connector URL
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2.5">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[13px] font-semibold text-ink">
              {mcpUrl}
            </code>
            <CopyButton text={mcpUrl} label="Copy URL" />
          </div>
          <p className="mt-2 text-[11.5px] text-ink-faint">
            Claude signs you in with your Google account — there is no token to paste.{' '}
            <Link href="/mcp-tokens" className="font-semibold text-primary hover:underline">
              Step-by-step for Claude, ChatGPT and Claude Code
            </Link>
            .
          </p>
        </div>

        {/* Trust strip */}
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3 text-[11.5px]">
          <TrustItem
            href="/tools"
            icon={<ShieldCheck className="h-3.5 w-3.5" />}
            label="Your access, your permissions"
          />
          <span className="text-ink-faint">·</span>
          <TrustItem
            href="/approvals"
            icon={<BadgeCheck className="h-3.5 w-3.5" />}
            label="Writes ask before running"
          />
          <span className="text-ink-faint">·</span>
          <TrustItem
            href={isAdmin ? '/admin/audit' : undefined}
            icon={<ScrollText className="h-3.5 w-3.5" />}
            label="Every action audited"
          />
        </div>
      </Panel>
    </>
  );
}

function TrustItem({
  href,
  icon,
  label,
}: {
  href?: string;
  icon: React.ReactNode;
  label: string;
}) {
  const body = (
    <>
      <span className="text-primary">{icon}</span>
      {label}
    </>
  );
  if (!href) {
    return <span className="inline-flex items-center gap-1.5 text-ink-muted">{body}</span>;
  }
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-ink-muted transition-colors hover:text-primary"
    >
      {body}
    </Link>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[13px] text-ink-faint">{children}</p>;
}

function StatChip({
  icon,
  value,
  label,
  tone = 'default',
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  tone?: 'default' | 'amber';
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-pill border px-3 py-1.5 text-xs',
        tone === 'amber'
          ? 'border-amber/40 bg-amber-soft text-amber'
          : 'border-border bg-surface-2 text-ink-muted',
      )}
    >
      {icon}
      <span className={clsx('stat-num text-[13px]', tone === 'amber' ? 'text-amber' : 'text-ink')}>
        {value.toLocaleString()}
      </span>
      {label}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const styles: Record<string, string> = {
    ok: 'bg-emerald-soft text-emerald',
    error: 'bg-rose-soft text-rose',
    running: 'bg-surface-2 text-ink-faint',
  };
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide',
        styles[status] ?? 'bg-surface-2 text-ink-faint',
      )}
    >
      {status}
    </span>
  );
}

function QuickAction({
  href,
  icon,
  label,
}: {
  href: string;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-2.5 rounded-card border border-border bg-surface px-3.5 py-3 shadow-card transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-pop"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-primary-soft text-primary">
        {icon}
      </span>
      <span className="truncate text-[13px] font-semibold text-ink">{label}</span>
      <ArrowRight className="ml-auto h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
    </Link>
  );
}
