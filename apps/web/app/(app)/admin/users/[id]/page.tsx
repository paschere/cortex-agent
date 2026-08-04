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
import { listTools } from '@cortex/agent-tools';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { relativeTime } from '@/lib/relative-time';
import { toolLabel } from '@/lib/tool-labels';
import { SURFACE_LABEL } from '@/app/api/admin/_lib/audit-filters';
import {
  DecisionTag,
  RiskTag,
  SignalChip,
  StatusTag,
  SurfaceTag,
  SURFACE_BAR,
} from '../../audit/_components/tags';
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

/** Header links: ruled and square, like every other control on the page. */
const HEADER_ACTION =
  'inline-flex items-center gap-2 rounded-card border border-border-strong bg-surface px-3.5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2';
const SURFACE_KEYS = ['web', 'mcp', 'schedule', 'unknown'] as const;

type Role = 'member' | 'team_admin' | 'org_admin';

const ROLE_LABEL: Record<string, string> = {
  org_admin: 'Admin de la organización',
  team_admin: 'Admin de equipo',
  member: 'Miembro',
};

const ROLE_TAG: Record<string, string> = {
  org_admin: 'border-primary/30 bg-primary-soft text-primary-ink',
  team_admin: 'border-sky/40 bg-sky-soft text-sky',
  member: 'border-border bg-surface-2 text-ink-muted',
};

const JOB_STATUS_LABEL: Record<string, string> = {
  active: 'Activa',
  paused: 'En pausa',
  completed: 'Terminada',
  cancelled: 'Cancelada',
};

const JOB_STATUS_TONE: Record<string, string> = {
  active: 'border-emerald/40 bg-emerald-soft text-emerald',
  paused: 'border-amber/40 bg-amber-soft text-amber',
  completed: 'border-border bg-surface-2 text-ink-faint',
  cancelled: 'border-border bg-surface-2 text-ink-faint',
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

/** Same matching rules as matchPattern in @cortex/agent-tools. */
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
      return { id: t?.id ?? m.team_id, name: t?.name ?? 'Equipo sin nombre' };
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
        subtitle={`Todo lo que esta persona ha hecho con Cortex en los últimos ${WINDOW_DAYS} días`}
        icon={<UserIcon className="h-5 w-5" />}
        actions={
          <>
            <Link href="/admin/users" className={HEADER_ACTION}>
              <ArrowLeft className="h-4 w-4" />
              Todas las personas
            </Link>
            <Link href={`/admin/audit?user=${user.id}&range=30d`} className={HEADER_ACTION}>
              <ScrollText className="h-4 w-4" />
              Auditoría
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
                    'rounded-card border px-2 py-0.5 text-[11px] font-semibold',
                    ROLE_TAG[user.role] ?? 'border-border bg-surface-2 text-ink-muted',
                  )}
                >
                  {ROLE_LABEL[user.role] ?? user.role}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-muted">
                <span className="tabular inline-flex items-center gap-1.5">
                  <Mail className="h-3.5 w-3.5 text-ink-faint" />
                  {user.email}
                </span>
                <span
                  className="inline-flex items-center gap-1.5"
                  title={absoluteTime(user.created_at)}
                >
                  <CalendarDays className="h-3.5 w-3.5 text-ink-faint" />
                  Entró el{' '}
                  <span className="tabular">
                    {new Date(user.created_at).toLocaleDateString('es-CO', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                    })}
                  </span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Activity className="h-3.5 w-3.5 text-ink-faint" />
                  {usage.lastActive
                    ? `Última actividad ${relativeTime(usage.lastActive)}`
                    : `Sin actividad hace ${WINDOW_DAYS} días`}
                </span>
              </div>
            </div>

            <div className="min-w-0">
              <SectionLabel>Equipos</SectionLabel>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {teams.length === 0 ? (
                  <EmptyNote>No está en ningún equipo, así que nada le resta acceso.</EmptyNote>
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
              <SectionLabel>Integraciones conectadas</SectionLabel>
              <span className="tabular text-[11px] text-ink-faint">
                {liveTokens > 0
                  ? `${liveTokens} conexión${liveTokens === 1 ? '' : 'es'} viva${liveTokens === 1 ? '' : 's'} con Claude`
                  : 'Sin conexión viva con Claude'}
              </span>
            </div>
            {integrations.length === 0 ? (
              <p className="mt-2.5 flex items-start gap-2 text-[12.5px] leading-relaxed text-ink-muted">
                <Unplug className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                No ha conectado nada. Las herramientas que dependen de Google, HubSpot, GitHub o
                Linear le van a fallar hasta que conecte esa cuenta desde Integraciones.
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
                        i.updated_at ? `Renovado el ${absoluteTime(i.updated_at)}` : '',
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
                        <span className="tabular block text-[10.5px] text-ink-faint">
                          {scopeCount} scope{scopeCount === 1 ? '' : 's'} ·{' '}
                          {expired
                            ? 'token vencido'
                            : i.expires_at
                              ? `vence ${countdown(i.expires_at)}`
                              : 'sin vencimiento'}
                        </span>
                      </span>
                    </span>
                  );
                })}
              </div>
            )}
            {integrations.some((i) => !!i.expires_at && i.expires_at <= nowIso) && (
              <p className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-[11.5px] leading-relaxed text-rose">
                Un token vencido es la razón más común de que las herramientas dejen de responder
                de un momento a otro. Pídele que vuelva a conectar esa cuenta en Integraciones.
              </p>
            )}
          </div>
        </Panel>

        {/* ---------------------------------------------------- cortex usage */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          <StatTile
            label="Llamadas · 7d"
            sub="Llamadas · 7d"
            value={usage.calls7d.toLocaleString()}
            icon={<Zap className="h-4 w-4" />}
          />
          <StatTile
            label="Llamadas · 30d"
            sub={`Llamadas · ${WINDOW_DAYS}d`}
            value={usage.calls30d.toLocaleString()}
            icon={<Activity className="h-4 w-4" />}
            tone="sky"
          />
          <StatTile
            label="Turnos de chat"
            sub={`Turnos de chat · ${WINDOW_DAYS}d`}
            value={usage.turns30d.toLocaleString()}
            icon={<MessageSquare className="h-4 w-4" />}
            tone="primary"
          />
          <StatTile
            label="Herramientas distintas"
            sub="Herramientas distintas"
            value={usage.distinctTools.toLocaleString()}
            icon={<Wrench className="h-4 w-4" />}
            tone="sky"
          />
          <StatTile
            label="Tasa de éxito"
            sub="Tasa de éxito"
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
            label="Latencia media"
            sub="Latencia media"
            value={usage.avgLatency > 0 ? formatLatency(usage.avgLatency) : '—'}
            icon={<Timer className="h-4 w-4" />}
            tone="amber"
          />
        </div>

        <Panel className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <SectionLabel>Actividad diaria · últimos {WINDOW_DAYS} días</SectionLabel>
            <span className="text-[11px] text-ink-faint">
              {usage.capped
                ? `con tope de ${AUDIT_ROW_CAP.toLocaleString()} eventos: esto es un piso`
                : 'todos los eventos registrados'}
            </span>
          </div>
          <DayBars days={usage.days} />
        </Panel>

        <div className="grid gap-4 lg:grid-cols-2">
          <Panel className="p-4">
            <SectionLabel>Herramientas más usadas · {WINDOW_DAYS}d</SectionLabel>
            <div className="mt-3">
              {usage.topTools.length === 0 ? (
                <EmptyNote>No ha ejecutado ninguna herramienta en esta ventana.</EmptyNote>
              ) : (
                <ul className="space-y-2.5">
                  {usage.topTools.map((t) => (
                    <li key={t.toolId}>
                      <div className="mb-1 flex items-center justify-between gap-2 text-[11.5px]">
                        <span className="min-w-0 truncate font-semibold text-ink">
                          {toolLabel(t.toolId).label}
                        </span>
                        <span className="tabular shrink-0 text-ink-faint">
                          {t.count}× · {formatLatency(t.avgLatency)}
                          {t.errors > 0 && (
                            <span className="ml-1 text-rose">· {t.errors} con error</span>
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
            <SectionLabel>Desde dónde trabaja</SectionLabel>
            <div className="mt-3">
              <StackedBar segments={surfaceSegments} total={surfaceTotal} />
              <p className="mt-3 text-[11.5px] leading-relaxed text-ink-faint">
                {surfaceTotal === 0
                  ? 'No hay llamadas registradas en esta ventana.'
                  : (usage.bySurface.unknown ?? 0) === surfaceTotal
                    ? 'Estas llamadas todavía no traen la superficie registrada.'
                    : 'La app web, Claude por MCP y las rutinas que corren solas.'}
              </p>
            </div>
          </Panel>
        </div>

        {/* -------------------------------------------------------- security */}
        <div id="security" className="scroll-mt-6 space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile
              label="Marcados · 7d"
              sub="Marcados · 7d"
              value={String(security.flagged7d)}
              icon={<Flag className="h-4 w-4" />}
              tone={security.flagged7d > 0 ? 'amber' : 'neutral'}
            />
            <StatTile
              label="Marcados · 30d"
              sub={`Marcados · ${WINDOW_DAYS}d`}
              value={String(security.flagged30d)}
              icon={<Flag className="h-4 w-4" />}
              tone={security.flagged30d > 0 ? 'amber' : 'neutral'}
            />
            <StatTile
              label="Bloqueados · 7d"
              sub="Bloqueados · 7d"
              value={String(security.blocked7d)}
              icon={<Ban className="h-4 w-4" />}
              tone={security.blocked7d > 0 ? 'rose' : 'neutral'}
            />
            <StatTile
              label="Bloqueados · 30d"
              sub={`Bloqueados · ${WINDOW_DAYS}d`}
              value={String(security.blocked30d)}
              icon={<Ban className="h-4 w-4" />}
              tone={security.blocked30d > 0 ? 'rose' : 'neutral'}
            />
          </div>

          <Panel className="overflow-hidden">
            <PanelHeadRow
              label="Revisión de seguridad"
              right={
                security.unavailable
                  ? 'la capa de seguridad no está migrada aquí'
                  : security.events.length === 0
                    ? 'sin novedades'
                    : `${security.events.length} en los últimos ${WINDOW_DAYS} días`
              }
            />
            {security.unavailable ? (
              <div className="px-4 py-8 text-center text-[12.5px] leading-relaxed text-ink-muted">
                Esta base de datos todavía no corrió la migración de seguridad, así que no se está
                registrando nada para nadie.
              </div>
            ) : securityClean ? (
              <div className="px-4 py-12 text-center">
                <ShieldCheck className="mx-auto mb-3 h-6 w-6 text-emerald" />
                <p className="text-[13px] font-semibold text-ink">Nada marcado</p>
                <p className="mt-1 text-[12.5px] text-ink-muted">
                  Todo lo que hizo esta persona fue rutinario.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[12px]">
                  <thead className="border-b border-border-strong bg-surface-2">
                    <tr className="text-left">
                      <th className="field-label px-4 py-2.5">Cuándo</th>
                      <th className="field-label px-4 py-2.5">Herramienta</th>
                      <th className="field-label px-4 py-2.5">Superficie</th>
                      <th className="field-label px-4 py-2.5">Nivel</th>
                      <th className="field-label px-4 py-2.5">Decisión</th>
                      <th className="field-label px-4 py-2.5">Motivo</th>
                      <th className="field-label px-4 py-2.5">Señales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {security.events.slice(0, 25).map((e) => (
                      <tr key={e.id} className="border-t border-border align-top">
                        <td
                          className="tabular whitespace-nowrap px-4 py-2 text-ink-faint"
                          title={absoluteTime(e.created_at)}
                        >
                          {relativeTime(e.created_at)}
                        </td>
                        <td className="max-w-[190px] px-4 py-2">
                          <div className="truncate font-semibold text-ink">
                            {toolLabel(e.tool_id).label}
                          </div>
                          <div className="tabular truncate text-[10.5px] text-ink-faint">
                            {e.tool_id}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <SurfaceTag surface={e.surface} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <RiskTag level={e.risk_level} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <DecisionTag decision={e.decision} />
                        </td>
                        <td className="max-w-[260px] px-4 py-2 text-ink-muted">
                          <span className="line-clamp-2">{e.reason}</span>
                        </td>
                        <td className="px-4 py-2">
                          {e.signals.length === 0 ? (
                            <span className="tabular text-ink-faint">—</span>
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
              <SectionLabel>Esperando su confirmación</SectionLabel>
              <span className="tabular text-[11px] text-ink-faint">
                {livePending.length === 0
                  ? 'nada pendiente'
                  : `${livePending.length} pendiente${livePending.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <div className="mt-3">
              {livePending.length === 0 ? (
                <EmptyNote>
                  No hay ninguna acción parada esperando un sí. Nada depende de esta persona ahora.
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
                        <span className="tabular block truncate text-[10.5px] text-ink-faint">
                          {p.tool_id}
                        </span>
                      </span>
                      <span
                        className="tabular inline-flex shrink-0 items-center gap-1.5 text-[11.5px] text-amber"
                        title={absoluteTime(p.expires_at)}
                      >
                        <Clock className="h-3.5 w-3.5" />
                        vence {countdown(p.expires_at)}
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
            <SectionLabel>Pipelines que creó</SectionLabel>
            <div className="mt-3">
              {pipelines.length === 0 ? (
                <EmptyNote>Todavía no ha creado ningún pipeline.</EmptyNote>
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
                          <span className="tabular block truncate text-[10.5px] text-ink-faint">
                            {p.slug}
                            {p.archived ? ' · archivado' : ''}
                          </span>
                        </span>
                        <span className="tabular shrink-0 text-[11px] text-ink-faint">
                          {(p.times_run ?? 0).toLocaleString()}{' '}
                          {(p.times_run ?? 0) === 1 ? 'corrida' : 'corridas'}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>

          <Panel className="p-4">
            <SectionLabel>Sus rutinas</SectionLabel>
            <div className="mt-3">
              {jobs.length === 0 ? (
                <EmptyNote>No hay ninguna rutina programada a su nombre.</EmptyNote>
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
                          <span className="tabular block truncate text-[10.5px] text-ink-faint">
                            {j.next_run_at
                              ? `próxima corrida ${countdown(j.next_run_at)}`
                              : 'sin próxima corrida'}
                            {j.is_global ? ' · para toda la organización' : ''}
                          </span>
                        </span>
                        <span
                          className={clsx(
                            'shrink-0 rounded-card border px-2 py-0.5 text-[10.5px] font-semibold',
                            JOB_STATUS_TONE[j.status] ?? 'border-border bg-surface-2 text-ink-faint',
                          )}
                        >
                          {JOB_STATUS_LABEL[j.status] ?? j.status}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Panel>

          <Panel className="p-4">
            <SectionLabel>Conversaciones recientes</SectionLabel>
            <div className="mt-3">
              {conversations.length === 0 ? (
                <EmptyNote>No hay conversaciones registradas.</EmptyNote>
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
                            {c.title || 'Conversación sin título'}
                          </span>
                          <span
                            className="tabular block truncate text-[10.5px] text-ink-faint"
                            title={absoluteTime(c.updated_at)}
                          >
                            {relativeTime(c.updated_at)}
                          </span>
                        </span>
                        <SurfaceTag surface={c.surface} />
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
            <SectionLabel>Acceso real a herramientas</SectionLabel>
            <span className="text-[11px] text-ink-faint">
              <span className="tabular">{reachableTools}</span> de{' '}
              <span className="tabular">{catalog.length}</span> herramientas a su alcance
            </span>
          </div>

          {teams.length === 0 ? (
            <p className="mt-3 flex items-start gap-2 text-[12.5px] text-ink-muted">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald" />
              No está en ningún equipo, así que nada le resta acceso: puede usar todas las
              herramientas que le permita su agente.
            </p>
          ) : denials.length === 0 ? (
            <p className="mt-3 flex items-start gap-2 text-[12.5px] text-ink-muted">
              <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald" />
              {teams.length === 1 ? 'Su equipo no le bloquea nada' : 'Sus equipos no le bloquean nada'}
              : puede usar todas las herramientas que le permita su agente.
            </p>
          ) : (
            <div className="mt-3">
              <div className="text-[11.5px] font-semibold text-ink">
                Bloqueado por sus equipos
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {denials.map((d) => {
                  const team = teams.find((t) => d.teams.includes(t.name));
                  return (
                    <Link key={d.pattern} href={`/tools?team=${team?.id ?? ''}`}>
                      <Chip tone="rose" title={`Bloqueado por ${d.teams.join(', ')}`}>
                        <ShieldBan className="h-3 w-3" />
                        <span className="tabular">{d.pattern}</span>
                        <span className="font-normal opacity-80">· {d.teams.join(', ')}</span>
                      </Chip>
                    </Link>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
                Los equipos solo restan: entrar a otro equipo nunca devuelve una herramienta
                bloqueada.
              </p>
            </div>
          )}

          <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-3">
            <div>
              <div className="text-[11px] font-semibold text-emerald">
                Familias abiertas (<span className="tabular">{openFamilies.length}</span>)
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {openFamilies.length === 0 ? (
                  <EmptyNote>Ninguna.</EmptyNote>
                ) : (
                  openFamilies.map((f) => (
                    <Chip key={f.name} tone="emerald" title={`${f.total} herramientas`}>
                      <span className="tabular">{f.name}</span>
                    </Chip>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-amber">
                Parcialmente restringidas (<span className="tabular">{partialFamilies.length}</span>)
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {partialFamilies.length === 0 ? (
                  <EmptyNote>Ninguna.</EmptyNote>
                ) : (
                  partialFamilies.map((f) => (
                    <Chip
                      key={f.name}
                      tone="amber"
                      title={`${f.denied} de ${f.total} herramientas bloqueadas`}
                    >
                      <span className="tabular">{f.name}</span>
                      <span className="tabular font-normal opacity-80">
                        {f.denied}/{f.total}
                      </span>
                    </Chip>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-semibold text-rose">
                Bloqueadas del todo (<span className="tabular">{closedFamilies.length}</span>)
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {closedFamilies.length === 0 ? (
                  <EmptyNote>Ninguna.</EmptyNote>
                ) : (
                  closedFamilies.map((f) => (
                    <Chip key={f.name} tone="rose" title={`las ${f.total} herramientas bloqueadas`}>
                      <span className="tabular">{f.name}</span>
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
            label="Actividad reciente"
            right={
              usage.recent.length === 0
                ? 'nada todavía'
                : `últimos ${usage.recent.length} evento${usage.recent.length === 1 ? '' : 's'}`
            }
          />
          {usage.legacySchema && (
            <p className="border-b border-border bg-amber-soft px-4 py-2 text-[11.5px] text-amber">
              Esta base de datos todavía no registra superficie, riesgo ni decisión.
            </p>
          )}
          {usage.recent.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <Workflow className="mx-auto mb-3 h-6 w-6 text-ink-faint" />
              <p className="text-[13px] font-semibold text-ink">
                Nada en los últimos {WINDOW_DAYS} días
              </p>
              <p className="mx-auto mt-1 max-w-md text-[12.5px] leading-relaxed text-ink-muted">
                Sus llamadas a herramientas, turnos de chat y rutinas van cayendo aquí a medida que
                ocurren.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead className="border-b border-border-strong bg-surface-2">
                  <tr className="text-left">
                    <th className="field-label px-4 py-2.5">Cuándo</th>
                    <th className="field-label px-4 py-2.5">Herramienta</th>
                    <th className="field-label px-4 py-2.5">Superficie</th>
                    <th className="field-label px-4 py-2.5">Estado</th>
                    <th className="field-label px-4 py-2.5">Riesgo</th>
                    <th className="field-label px-4 py-2.5 text-right">Latencia</th>
                    <th className="field-label px-4 py-2.5">Detalle</th>
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
                          className="tabular whitespace-nowrap px-4 py-2 text-ink-faint"
                          title={absoluteTime(e.created_at)}
                        >
                          {relativeTime(e.created_at)}
                        </td>
                        <td className="max-w-[220px] px-4 py-2">
                          <div className="truncate font-semibold text-ink">
                            {isAgentTurn(e.tool_id) ? 'Turno de chat' : toolLabel(e.tool_id).label}
                          </div>
                          {!isAgentTurn(e.tool_id) && (
                            <div className="tabular truncate text-[10.5px] text-ink-faint">
                              {e.tool_id}
                            </div>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <SurfaceTag surface={e.surface} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          <StatusTag status={e.status} />
                        </td>
                        <td className="whitespace-nowrap px-4 py-2">
                          {e.risk_level ? (
                            <span className="flex items-center gap-1">
                              <RiskTag level={e.risk_level} />
                              <DecisionTag decision={e.decision} />
                            </span>
                          ) : (
                            <span className="tabular text-ink-faint">—</span>
                          )}
                        </td>
                        <td className="tabular whitespace-nowrap px-4 py-2 text-right text-ink-faint">
                          {formatLatency(e.latency_ms)}
                        </td>
                        <td className="max-w-[300px] px-4 py-2 text-ink-muted">
                          {detail ? (
                            <span className="line-clamp-2">{detail}</span>
                          ) : (
                            <span className="tabular text-ink-faint">—</span>
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
              Ver todo en la auditoría
              <ChevronRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </Panel>
      </div>
    </>
  );
}
