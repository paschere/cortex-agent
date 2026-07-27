import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { clsx } from 'clsx';
import {
  Activity,
  AlarmClock,
  ArrowLeft,
  Ban,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  Clock,
  Flag,
  KeyRound,
  Mail,
  MessageSquare,
  Plug,
  ScrollText,
  ShieldBan,
  ShieldCheck,
  Timer,
  Unplug,
  User as UserIcon,
  Users2,
  Workflow,
  Wrench,
  Zap,
} from 'lucide-react';
import { listTools } from '@zipdev/agent-tools';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { toolLabel } from '@/lib/tool-labels';
import { SURFACE_LABEL } from '@/app/api/admin/_lib/audit-filters';
import {
  DecisionPill,
  RiskPill,
  SignalChip,
  StatusPill,
  SurfacePill,
  SURFACE_BAR,
} from '../../audit/_components/pills';
import { absoluteTime, eventDetail, formatLatency, isAgentTurn } from '../../audit/_components/format';
import {
  Chip,
  CountBar,
  DayBars,
  EmptyNote,
  SectionLabel,
  StackedBar,
  StatTile,
} from '../_components/blocks';
import { countdown } from '../_lib/countdown';
import {
  AUDIT_ROW_CAP,
  fetchUserSecurity,
  fetchUserUsage,
  WINDOW_DAYS,
} from '../_lib/user-activity';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SURFACE_KEYS = ['web', 'mcp', 'schedule', 'unknown'] as const;

type Role = 'member' | 'team_admin' | 'org_admin';

const ROLE_PILL: Record<string, string> = {
  org_admin: 'bg-primary-soft text-primary-ink',
  team_admin: 'bg-sky-soft text-sky',
  member: 'bg-surface-2 text-ink-muted',
};

const JOB_STATUS_TONE: Record<string, string> = {
  active: 'bg-emerald-soft text-emerald',
  paused: 'bg-amber-soft text-amber',
  completed: 'bg-surface-2 text-ink-faint',
  cancelled: 'bg-surface-2 text-ink-faint',
};

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  created_at: string;
}

interface IntegrationRow {
  provider: string;
  scopes: string[] | null;
  expires_at: string | null;
  updated_at: string | null;
}

interface PipelineRow {
  id: string;
  name: string;
  slug: string;
  times_run: number | null;
  last_run_at: string | null;
  archived: boolean | null;
}

interface JobRow {
  id: string;
  name: string;
  status: string;
  is_global: boolean | null;
  next_run_at: string | null;
}

interface ConversationRow {
  id: string;
  title: string | null;
  surface: string | null;
  updated_at: string;
}

interface PendingRow {
  id: string;
  tool_id: string;
  expires_at: string;
}

/** Supabase embeds arrive as an object or a single-element array depending on the join. */
function firstEmbed<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** Same matching rules as matchPattern in @zipdev/agent-tools. */
function matchPattern(pattern: string, toolId: string): boolean {
  return pattern.endsWith('.*') ? toolId.startsWith(pattern.slice(0, -1)) : pattern === toolId;
}

function PanelHeadRow({ label, right }: { label: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
      <SectionLabel>{label}</SectionLabel>
      {right && <span className="text-[11px] text-ink-faint">{right}</span>}
    </div>
  );
}

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const sb = getSupabaseServiceClient();
  const { data: userData } = await sb
    .from('users')
    .select('id, email, name, role, created_at')
    .eq('id', id)
    .maybeSingle();

  const user = (userData ?? null) as UserRow | null;
  if (!user) notFound();

  const nowIso = new Date().toISOString();

  const [
    membershipRes,
    integrationRes,
    usage,
    security,
    pendingRes,
    pipelineRes,
    jobRes,
    conversationRes,
    tokenRes,
  ] = await Promise.all([
    sb.from('team_members').select('team_id, teams(id, name)').eq('user_id', id),
    sb
      .from('integrations')
      .select('provider, scopes, expires_at, updated_at')
      .eq('user_id', id)
      .order('provider'),
    fetchUserUsage(sb, id),
    fetchUserSecurity(sb, id),
    sb
      .from('mcp_pending_actions')
      .select('id, tool_id, expires_at')
      .eq('user_id', id)
      // Still waiting on them — a row answered from a Chat card is not pending.
      .is('decision', null)
      .order('expires_at', { ascending: true })
      .limit(20),
    sb
      .from('pipelines')
      .select('id, name, slug, times_run, last_run_at, archived')
      .eq('created_by', id)
      .order('times_run', { ascending: false })
      .limit(12),
    sb
      .from('scheduled_jobs')
      .select('id, name, status, is_global, next_run_at')
      .eq('user_id', id)
      .order('next_run_at', { ascending: true, nullsFirst: false })
      .limit(12),
    sb
      .from('conversations')
      .select('id, title, surface, updated_at')
      .eq('user_id', id)
      .order('updated_at', { ascending: false })
      .limit(8),
    sb
      .from('oauth_access_tokens')
      .select('token_hash', { count: 'exact', head: true })
      .eq('user_id', id)
      .gt('expires_at', nowIso),
  ]);

  const teams = ((membershipRes.data ?? []) as unknown as Array<{
    team_id: string;
    teams: { id: string; name: string } | { id: string; name: string }[] | null;
  }>)
    .map((m) => {
      const t = firstEmbed(m.teams);
      return { id: t?.id ?? m.team_id, name: t?.name ?? 'Unnamed team' };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const integrations = (integrationRes.data ?? []) as unknown as IntegrationRow[];
  const pending = ((pendingRes.data ?? []) as unknown as PendingRow[]) ?? [];
  const pipelines = ((pipelineRes.data ?? []) as unknown as PipelineRow[]) ?? [];
  const jobs = ((jobRes.data ?? []) as unknown as JobRow[]) ?? [];
  const conversations = ((conversationRes.data ?? []) as unknown as ConversationRow[]) ?? [];
  const liveTokens = tokenRes.count ?? 0;

  // Denied tool patterns come from the teams this person belongs to — one read,
  // scoped to their team ids, never one per team.
  let denials: Array<{ pattern: string; teams: string[] }> = [];
  if (teams.length > 0) {
    const { data: permData } = await sb
      .from('team_tool_permissions')
      .select('team_id, tool_pattern')
      .in(
        'team_id',
        teams.map((t) => t.id),
      )
      .eq('allowed', false);
    const byPattern = new Map<string, Set<string>>();
    for (const row of (permData ?? []) as unknown as Array<{
      team_id: string;
      tool_pattern: string;
    }>) {
      const teamName = teams.find((t) => t.id === row.team_id)?.name ?? 'a team';
      const set = byPattern.get(row.tool_pattern) ?? new Set<string>();
      set.add(teamName);
      byPattern.set(row.tool_pattern, set);
    }
    denials = [...byPattern.entries()]
      .map(([pattern, names]) => ({ pattern, teams: [...names].sort() }))
      .sort((a, b) => a.pattern.localeCompare(b.pattern));
  }

  const deniedPatterns = denials.map((d) => d.pattern);
  const catalog = listTools()
    .map((t) => t.id)
    .filter((toolId) => !toolId.startsWith('test.'));

  const familyMap = new Map<string, { total: number; denied: number }>();
  for (const toolId of catalog) {
    const family = toolId.split('.')[0] ?? toolId;
    const f = familyMap.get(family) ?? { total: 0, denied: 0 };
    f.total += 1;
    if (deniedPatterns.some((p) => matchPattern(p, toolId))) f.denied += 1;
    familyMap.set(family, f);
  }
  const families = [...familyMap.entries()]
    .map(([name, f]) => ({ name, ...f }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const openFamilies = families.filter((f) => f.denied === 0);
  const partialFamilies = families.filter((f) => f.denied > 0 && f.denied < f.total);
  const closedFamilies = families.filter((f) => f.denied > 0 && f.denied === f.total);
  const reachableTools = catalog.length - families.reduce((n, f) => n + f.denied, 0);

  const displayName = user.name || user.email;
  const surfaceSegments = SURFACE_KEYS.map((k) => ({
    key: k,
    label: SURFACE_LABEL[k] ?? k,
    value: usage.bySurface[k] ?? 0,
    color: SURFACE_BAR[k] ?? 'bg-border-strong',
  }));
  const surfaceTotal = surfaceSegments.reduce((n, s) => n + s.value, 0);
  const maxToolCount = usage.topTools[0]?.count ?? 1;
  const securityClean = !security.unavailable && security.events.length === 0;
  const livePending = pending.filter((p) => p.expires_at > nowIso);

  return (
    <>
      <PageHeader
        title={displayName}
        subtitle={`Everything this teammate has done with Zippy — last ${WINDOW_DAYS} days`}
        icon={<UserIcon className="h-5 w-5" />}
        actions={
          <>
            <Link
              href="/admin/users"
              className="inline-flex items-center gap-2 rounded-pill border border-border bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink-muted shadow-card hover:text-ink"
            >
              <ArrowLeft className="h-4 w-4" />
              All users
            </Link>
            <Link
              href={`/admin/audit?user=${user.id}&range=30d`}
              className="inline-flex items-center gap-2 rounded-pill border border-border bg-surface px-3.5 py-2 text-[12.5px] font-semibold text-ink-muted shadow-card hover:text-ink"
            >
              <ScrollText className="h-4 w-4" />
              Audit log
            </Link>
          </>
        }
      />

      <div className="space-y-4">
        {/* ------------------------------------------------------- identity */}
        <Panel className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[17px] font-extrabold tracking-tight text-ink">
                  {displayName}
                </h2>
                <span
                  className={clsx(
                    'rounded-pill px-2 py-0.5 text-[10.5px] font-bold uppercase',
                    ROLE_PILL[user.role] ?? 'bg-surface-2 text-ink-muted',
                  )}
                >
                  {user.role.replace('_', ' ')}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5 text-ink-faint" />
                  {user.email}
                </span>
                <span
                  className="inline-flex items-center gap-1.5"
                  title={absoluteTime(user.created_at)}
                >
                  <CalendarDays className="h-3.5 w-3.5 text-ink-faint" />
                  Member since{' '}
                  {new Date(user.created_at).toLocaleDateString('en-US', {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-ink-faint" />
                  {usage.lastActive
                    ? `Last active ${relativeTime(usage.lastActive)}`
                    : `No activity in ${WINDOW_DAYS} days`}
                </span>
              </div>
            </div>

            <div className="min-w-0">
              <SectionLabel>Teams</SectionLabel>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {teams.length === 0 ? (
                  <EmptyNote>On no team — unrestricted tool access.</EmptyNote>
                ) : (
                  teams.map((t) => (
                    <Link key={t.id} href={`/tools?team=${t.id}`}>
                      <Chip tone="sky">
                        <Users2 className="h-3 w-3" />
                        {t.name}
                      </Chip>
                    </Link>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionLabel>Connected integrations</SectionLabel>
              <span className="text-[11px] text-ink-faint">
                {liveTokens > 0
                  ? `${liveTokens} live Claude connection${liveTokens === 1 ? '' : 's'}`
                  : 'No live Claude connection'}
              </span>
            </div>
            {integrations.length === 0 ? (
              <p className="mt-2.5 flex items-center gap-2 text-[12.5px] text-ink-faint">
                <Unplug className="h-3.5 w-3.5" />
                Nothing connected yet — tools that need Google, HubSpot, GitHub or Linear will
                fail for this person until they connect an account.
              </p>
            ) : (
              <div className="mt-2.5 flex flex-wrap gap-2">
                {integrations.map((i) => {
                  const scopeCount = (i.scopes ?? []).length;
                  const expired = !!i.expires_at && i.expires_at <= nowIso;
                  return (
                    <span
                      key={i.provider}
                      title={[
                        (i.scopes ?? []).join('\n'),
                        i.updated_at ? `Refreshed ${absoluteTime(i.updated_at)}` : '',
                      ]
                        .filter(Boolean)
                        .join('\n\n')}
                      className={clsx(
                        'inline-flex items-center gap-2 rounded-card border px-3 py-2',
                        expired ? 'border-rose bg-rose-soft' : 'border-border bg-surface-2',
                      )}
                    >
                      <Plug
                        className={clsx('h-3.5 w-3.5', expired ? 'text-rose' : 'text-emerald')}
                      />
                      <span className="min-w-0">
                        <span
                          className={clsx(
                            'block text-[12.5px] font-bold capitalize leading-tight',
                            expired ? 'text-rose' : 'text-ink',
                          )}
                        >
                          {i.provider}
                        </span>
                        <span className="block text-[10.5px] text-ink-faint">
                          {scopeCount} scope{scopeCount === 1 ? '' : 's'} ·{' '}
                          {expired
                            ? 'token expired'
                            : i.expires_at
                              ? `expires ${countdown(i.expires_at)}`
                              : 'no expiry'}
                        </span>
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
            {integrations.some((i) => !!i.expires_at && i.expires_at <= nowIso) && (
              <p className="mt-2 text-[11.5px] text-rose">
                An expired token is usually why a teammate&apos;s tools suddenly stop working —
                they need to reconnect from Integrations.
              </p>
            )}
          </div>
        </Panel>

        {/* ---------------------------------------------------- zippy usage */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <StatTile
            label="Tool calls · 7d"
            sub="Tool calls · 7d"
            value={usage.calls7d.toLocaleString()}
            icon={<Zap className="h-4 w-4" />}
          />
          <StatTile
            label="Tool calls · 30d"
            sub={`Tool calls · ${WINDOW_DAYS}d`}
            value={usage.calls30d.toLocaleString()}
            icon={<Activity className="h-4 w-4" />}
            tone="sky"
          />
          <StatTile
            label="Chat turns"
            sub={`Chat turns · ${WINDOW_DAYS}d`}
            value={usage.turns30d.toLocaleString()}
            icon={<MessageSquare className="h-4 w-4" />}
            tone="primary"
          />
          <StatTile
            label="Distinct tools"
            sub="Distinct tools used"
            value={usage.distinctTools.toLocaleString()}
            icon={<Wrench className="h-4 w-4" />}
            tone="sky"
          />
          <StatTile
            label="Success rate"
            sub="Success rate"
            value={usage.successRate === null ? '—' : `${usage.successRate}%`}
            icon={<CheckCircle2 className="h-4 w-4" />}
            tone={
              usage.successRate === null || usage.successRate >= 95
                ? 'emerald'
                : usage.successRate >= 80
                  ? 'amber'
                  : 'rose'
            }
          />
          <StatTile
            label="Avg latency"
            sub="Average latency"
            value={usage.avgLatency > 0 ? formatLatency(usage.avgLatency) : '—'}
            icon={<Timer className="h-4 w-4" />}
            tone="amber"
          />
        </div>

        <Panel className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <SectionLabel>Daily activity · last {WINDOW_DAYS} days</SectionLabel>
            <span className="text-[11px] text-ink-faint">
              {usage.capped
                ? `capped at ${AUDIT_ROW_CAP.toLocaleString()} events — this is a floor`
                : 'every recorded event'}
            </span>
          </div>
          <DayBars days={usage.days} />
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel className="p-4">
            <SectionLabel>Top tools · {WINDOW_DAYS}d</SectionLabel>
            <div className="mt-3">
              {usage.topTools.length === 0 ? (
                <EmptyNote>
                  This teammate has not run a single tool in this window.
                </EmptyNote>
              ) : (
                <ul className="space-y-2.5">
                  {usage.topTools.map((t) => (
                    <li key={t.toolId}>
                      <div className="mb-1 flex items-center justify-between gap-2 text-[11.5px]">
                        <span className="min-w-0 truncate font-semibold text-ink">
                          {toolLabel(t.toolId).label}
                        </span>
                        <span className="shrink-0 text-ink-faint">
                          {t.count}× · {formatLatency(t.avgLatency)}
                          {t.errors > 0 && (
                            <span className="ml-1 text-rose">· {t.errors} err</span>
                          )}
                        </span>
                      </div>
                      <CountBar
                        value={t.count}
                        max={maxToolCount}
                        tone={t.errors > 0 ? 'bg-amber' : 'bg-primary'}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>

          <Panel className="p-4">
            <SectionLabel>Where they work</SectionLabel>
            <div className="mt-3">
              <StackedBar segments={surfaceSegments} total={surfaceTotal} />
              <p className="mt-3 text-[11.5px] text-ink-faint">
                {surfaceTotal === 0
                  ? 'No calls recorded in this window.'
                  : (usage.bySurface.unknown ?? 0) === surfaceTotal
                    ? 'No surface was recorded on these calls yet.'
                    : 'The web app, Claude via MCP, and unattended scheduled runs.'}
              </p>
            </div>
          </Panel>
        </div>

        {/* -------------------------------------------------------- security */}
        <div id="security" className="scroll-mt-6 space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Flagged · 7d"
              sub="Flagged · 7d"
              value={String(security.flagged7d)}
              icon={<Flag className="h-4 w-4" />}
              tone={security.flagged7d > 0 ? 'amber' : 'neutral'}
            />
            <StatTile
              label="Flagged · 30d"
              sub={`Flagged · ${WINDOW_DAYS}d`}
              value={String(security.flagged30d)}
              icon={<Flag className="h-4 w-4" />}
              tone={security.flagged30d > 0 ? 'amber' : 'neutral'}
            />
            <StatTile
              label="Blocked · 7d"
              sub="Blocked · 7d"
              value={String(security.blocked7d)}
              icon={<Ban className="h-4 w-4" />}
              tone={security.blocked7d > 0 ? 'rose' : 'neutral'}
            />
            <StatTile
              label="Blocked · 30d"
              sub={`Blocked · ${WINDOW_DAYS}d`}
              value={String(security.blocked30d)}
              icon={<Ban className="h-4 w-4" />}
              tone={security.blocked30d > 0 ? 'rose' : 'neutral'}
            />
          </div>

          <Panel className="overflow-hidden">
            <PanelHeadRow
              label="Security review"
              right={
                security.unavailable
                  ? 'security layer not migrated here'
                  : security.events.length === 0
                    ? 'all clear'
                    : `${security.events.length} in the last ${WINDOW_DAYS} days`
              }
            />
            {security.unavailable ? (
              <div className="px-4 py-8 text-center text-[12.5px] text-ink-faint">
                This database has not run the security migration yet, so nothing is recorded for
                anyone.
              </div>
            ) : securityClean ? (
              <div className="px-4 py-12 text-center">
                <ShieldCheck className="mx-auto mb-3 h-6 w-6 text-emerald" />
                <p className="text-[13px] font-semibold text-ink">Nothing flagged</p>
                <p className="mt-1 text-[12px] text-ink-faint">
                  Every action this person took was routine.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead className="border-b border-border bg-surface-2/60">
                    <tr className="text-left text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
                      <th className="px-4 py-2.5 font-semibold">When</th>
                      <th className="px-4 py-2.5 font-semibold">Tool</th>
                      <th className="px-4 py-2.5 font-semibold">Surface</th>
                      <th className="px-4 py-2.5 font-semibold">Level</th>
                      <th className="px-4 py-2.5 font-semibold">Decision</th>
                      <th className="px-4 py-2.5 font-semibold">Reason</th>
                      <th className="px-4 py-2.5 font-semibold">Signals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {security.events.slice(0, 25).map((e) => (
                      <tr key={e.id} className="border-t border-border align-top">
                        <td
                          className="whitespace-nowrap px-4 py-2 text-ink-faint"
                          title={absoluteTime(e.created_at)}
                        >
                          {relativeTime(e.created_at)}
                        </td>
                        <td className="max-w-[190px] px-4 py-2">
                          <div className="truncate font-semibold text-ink">
                            {toolLabel(e.tool_id).label}
                          </div>
                          <div className="truncate font-mono text-[10.5px] text-ink-faint">
                            {e.tool_id}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <SurfacePill surface={e.surface} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <RiskPill level={e.risk_level} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <DecisionPill decision={e.decision} />
                        </td>
                        <td className="max-w-[260px] px-4 py-2 text-ink-muted">
                          <span className="line-clamp-2">{e.reason}</span>
                        </td>
                        <td className="px-4 py-2">
                          {e.signals.length === 0 ? (
                            <span className="text-ink-faint">—</span>
                          ) : (
                            <span className="flex flex-wrap gap-1">
                              {e.signals.slice(0, 4).map((s) => (
                                <SignalChip key={s}>{s}</SignalChip>
                              ))}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionLabel>Waiting on their confirmation</SectionLabel>
              <span className="text-[11px] text-ink-faint">
                {livePending.length === 0 ? 'nothing pending' : `${livePending.length} pending`}
              </span>
            </div>
            <div className="mt-3">
              {livePending.length === 0 ? (
                <EmptyNote>
                  No action is parked waiting for a yes — nothing is stuck on this person.
                </EmptyNote>
              ) : (
                <ul className="space-y-2">
                  {livePending.map((p) => (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-card bg-surface-2 px-3 py-2"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[12.5px] font-semibold text-ink">
                          {toolLabel(p.tool_id).label}
                        </span>
                        <span className="block truncate font-mono text-[10.5px] text-ink-faint">
                          {p.tool_id}
                        </span>
                      </span>
                      <span
                        className="inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-amber"
                        title={absoluteTime(p.expires_at)}
                      >
                        <Clock className="h-3.5 w-3.5" />
                        expires {countdown(p.expires_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        </div>

        {/* ------------------------------------------- what they've built */}
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel className="p-4">
            <SectionLabel>Pipelines they own</SectionLabel>
            <div className="mt-3">
              {pipelines.length === 0 ? (
                <EmptyNote>Has not created a pipeline yet.</EmptyNote>
              ) : (
                <ul className="space-y-1.5">
                  {pipelines.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={`/pipelines/${p.slug}`}
                        className="group flex items-center justify-between gap-2 rounded-card px-2 py-1.5 hover:bg-surface-2"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[12.5px] font-semibold text-ink group-hover:text-primary">
                            {p.name}
                          </span>
                          <span className="block truncate font-mono text-[10.5px] text-ink-faint">
                            {p.slug}
                            {p.archived ? ' · archived' : ''}
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] text-ink-faint">
                          {(p.times_run ?? 0).toLocaleString()} run
                          {(p.times_run ?? 0) === 1 ? '' : 's'}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>

          <Panel className="p-4">
            <SectionLabel>Their routines</SectionLabel>
            <div className="mt-3">
              {jobs.length === 0 ? (
                <EmptyNote>No scheduled routine runs under their name.</EmptyNote>
              ) : (
                <ul className="space-y-1.5">
                  {jobs.map((j) => (
                    <li key={j.id}>
                      <Link
                        href="/schedules"
                        className="group flex items-center justify-between gap-2 rounded-card px-2 py-1.5 hover:bg-surface-2"
                      >
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <AlarmClock className="h-3 w-3 shrink-0 text-ink-faint" />
                            <span className="truncate text-[12.5px] font-semibold text-ink group-hover:text-primary">
                              {j.name}
                            </span>
                          </span>
                          <span className="block truncate text-[10.5px] text-ink-faint">
                            {j.next_run_at ? `next run ${countdown(j.next_run_at)}` : 'no next run'}
                            {j.is_global ? ' · workspace-wide' : ''}
                          </span>
                        </span>
                        <span
                          className={clsx(
                            'shrink-0 rounded-pill px-2 py-0.5 text-[10px] font-bold uppercase',
                            JOB_STATUS_TONE[j.status] ?? 'bg-surface-2 text-ink-faint',
                          )}
                        >
                          {j.status}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>

          <Panel className="p-4">
            <SectionLabel>Recent conversations</SectionLabel>
            <div className="mt-3">
              {conversations.length === 0 ? (
                <EmptyNote>No conversations on record.</EmptyNote>
              ) : (
                <ul className="space-y-1.5">
                  {conversations.map((c) => (
                    <li key={c.id}>
                      <Link
                        href={`/conversations/${c.id}`}
                        className="group flex items-center justify-between gap-2 rounded-card px-2 py-1.5 hover:bg-surface-2"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-[12.5px] font-semibold text-ink group-hover:text-primary">
                            {c.title || 'Untitled conversation'}
                          </span>
                          <span
                            className="block truncate text-[10.5px] text-ink-faint"
                            title={absoluteTime(c.updated_at)}
                          >
                            {relativeTime(c.updated_at)}
                          </span>
                        </span>
                        <SurfacePill surface={c.surface} />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>
        </div>

        {/* -------------------------------------------- effective tool access */}
        <Panel className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SectionLabel>Effective tool access</SectionLabel>
            <span className="text-[11px] text-ink-faint">
              {reachableTools} of {catalog.length} tools reachable
            </span>
          </div>

          {teams.length === 0 ? (
            <p className="mt-3 flex items-start gap-2 text-[12.5px] text-ink-muted">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald" />
              They belong to no team, so nothing is taken away — they can use every tool their
              agent allows.
            </p>
          ) : denials.length === 0 ? (
            <p className="mt-3 flex items-start gap-2 text-[12.5px] text-ink-muted">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald" />
              Their {teams.length === 1 ? 'team places' : 'teams place'} no restrictions — they can
              use every tool their agent allows.
            </p>
          ) : (
            <div className="mt-3">
              <div className="text-[11.5px] font-semibold text-ink">Denied by their teams</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {denials.map((d) => {
                  const team = teams.find((t) => d.teams.includes(t.name));
                  return (
                    <Link key={d.pattern} href={`/tools?team=${team?.id ?? ''}`}>
                      <Chip tone="rose" title={`Denied by ${d.teams.join(', ')}`}>
                        <ShieldBan className="h-3 w-3" />
                        <span className="font-mono">{d.pattern}</span>
                        <span className="font-normal opacity-80">· {d.teams.join(', ')}</span>
                      </Chip>
                    </Link>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] text-ink-faint">
                Teams only ever subtract — joining another team never gives a denied tool back.
              </p>
            </div>
          )}

          <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-3">
            <div>
              <div className="text-[11px] font-semibold text-emerald">
                Open families ({openFamilies.length})
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {openFamilies.length === 0 ? (
                  <EmptyNote>None.</EmptyNote>
                ) : (
                  openFamilies.map((f) => (
                    <Chip key={f.name} tone="emerald" title={`${f.total} tools`}>
                      <span className="font-mono">{f.name}</span>
                    </Chip>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-amber">
                Partly restricted ({partialFamilies.length})
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {partialFamilies.length === 0 ? (
                  <EmptyNote>None.</EmptyNote>
                ) : (
                  partialFamilies.map((f) => (
                    <Chip
                      key={f.name}
                      tone="amber"
                      title={`${f.denied} of ${f.total} tools denied`}
                    >
                      <span className="font-mono">{f.name}</span>
                      <span className="font-normal opacity-80">
                        {f.denied}/{f.total}
                      </span>
                    </Chip>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-rose">
                Fully blocked ({closedFamilies.length})
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {closedFamilies.length === 0 ? (
                  <EmptyNote>None.</EmptyNote>
                ) : (
                  closedFamilies.map((f) => (
                    <Chip key={f.name} tone="rose" title={`all ${f.total} tools denied`}>
                      <span className="font-mono">{f.name}</span>
                    </Chip>
                  ))
                )}
              </div>
            </div>
          </div>
        </Panel>

        {/* ------------------------------------------------- recent activity */}
        <Panel className="overflow-hidden">
          <PanelHeadRow
            label="Recent activity"
            right={
              usage.recent.length === 0
                ? 'nothing yet'
                : `last ${usage.recent.length} event${usage.recent.length === 1 ? '' : 's'}`
            }
          />
          {usage.legacySchema && (
            <p className="border-b border-border bg-amber-soft px-4 py-2 text-[11.5px] text-amber">
              Surface, risk and decision are not recorded on this database yet.
            </p>
          )}
          {usage.recent.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <Workflow className="mx-auto mb-3 h-6 w-6 text-ink-faint" />
              <p className="text-[13px] font-semibold text-ink">Nothing in the last {WINDOW_DAYS} days</p>
              <p className="mt-1 text-[12px] text-ink-faint">
                Their tool calls, chat turns and scheduled runs will land here as they happen.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="border-b border-border bg-surface-2/60">
                  <tr className="text-left text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
                    <th className="px-4 py-2.5 font-semibold">When</th>
                    <th className="px-4 py-2.5 font-semibold">Tool</th>
                    <th className="px-4 py-2.5 font-semibold">Surface</th>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                    <th className="px-4 py-2.5 font-semibold">Risk</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Latency</th>
                    <th className="px-4 py-2.5 font-semibold">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.recent.map((e) => {
                    const detail = eventDetail(e);
                    const risky = e.risk_level === 'critical' || e.decision === 'blocked';
                    return (
                      <tr
                        key={e.id}
                        className={clsx(
                          'border-t border-border align-top',
                          risky && 'bg-rose-soft/40',
                        )}
                      >
                        <td
                          className="whitespace-nowrap px-4 py-2 text-ink-faint"
                          title={absoluteTime(e.created_at)}
                        >
                          {relativeTime(e.created_at)}
                        </td>
                        <td className="max-w-[220px] px-4 py-2">
                          <div className="truncate font-semibold text-ink">
                            {isAgentTurn(e.tool_id) ? 'Chat turn' : toolLabel(e.tool_id).label}
                          </div>
                          {!isAgentTurn(e.tool_id) && (
                            <div className="truncate font-mono text-[10.5px] text-ink-faint">
                              {e.tool_id}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <SurfacePill surface={e.surface} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <StatusPill status={e.status} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          {e.risk_level ? (
                            <span className="flex items-center gap-1">
                              <RiskPill level={e.risk_level} />
                              <DecisionPill decision={e.decision} />
                            </span>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-right text-ink-faint">
                          {formatLatency(e.latency_ms)}
                        </td>
                        <td className="max-w-[300px] px-4 py-2 text-ink-muted">
                          {detail ? (
                            <span className="line-clamp-2">{detail}</span>
                          ) : (
                            <span className="text-ink-faint">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="border-t border-border px-4 py-2.5 text-right">
            <Link
              href={`/admin/audit?user=${user.id}&range=30d`}
              className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-primary hover:underline"
            >
              See all in the audit log
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </Panel>
      </div>
    </>
  );
}
