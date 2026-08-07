'use client';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import { Provenance } from '@/components/ui/provenance';
import {
  BLAST_LABEL,
  BLOCK_BLURB,
  BLOCK_LABEL,
  BLOCK_ORDER,
  type BlastRadius,
  type BlockReason,
  CAPABILITY_GROUPS,
  type FamilyTone,
  GROUP_ORDER,
  RISK_LABEL,
  type RiskLevel,
  SENSITIVITY_LABEL,
  type Sensitivity,
  familyMeta,
  groupMeta,
  providerLabel,
  qualifiedToolLabel,
} from '@/lib/tool-taxonomy';
import { clsx } from 'clsx';
import {
  AlarmClock,
  BarChart3,
  BookOpen,
  Bot,
  Boxes,
  Building2,
  CalendarDays,
  Car,
  ChevronDown,
  CircleCheck,
  Clock3,
  FileText,
  FlaskConical,
  FolderOpen,
  Gauge,
  GitBranch,
  Globe,
  Handshake,
  Inbox,
  KeyRound,
  Lock,
  Mail,
  MessageSquare,
  MessagesSquare,
  Mic,
  PlugZap,
  Power,
  Search,
  Send,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquareKanban,
  Table2,
  TrendingUp,
  TriangleAlert,
  Type,
  Users,
  Users2,
  UsersRound,
  Wallet,
  Workflow,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { CustomTools } from './CustomTools';

/**
 * Plain serialisable shape resolved by the server page. Nothing here may be
 * derived from `@cortex/agent-tools` on the client — importing the registry
 * into a client module breaks the production build.
 */
export interface CatalogTool {
  id: string;
  /**
   * `registry` came from listTools(); `custom` is a `custom_tools` row this
   * workspace defined; `mcp` is proxied from a connected server.
   */
  kind: 'registry' | 'custom' | 'mcp';
  /** Humanised action name — resolved on the server so MCP ids survive it. */
  title: string;
  family: string;
  /** Capability group id: how a person, not the code, files this tool. */
  group: string;
  description: string;
  /** The tool declares requiresConfirmation, or the guardrail gates it. */
  needsApproval: boolean;
  /** Plain-language why, shown only when approval is required. */
  approvalReason: string | null;
  /** Null for MCP tools: they never pass through the classifier. */
  riskLevel: RiskLevel | null;
  sensitivity: Sensitivity | null;
  blastRadius: BlastRadius | null;
  /** The policy treats this tool as able to deliver content to an outsider. */
  canLeaveCompany: boolean;
  /** Risk once addressed outside the company, when it differs from the baseline. */
  outboundRiskLevel: RiskLevel | null;
  ratePerMinute: number | null;
  /** Integration providers this tool needs (e.g. 'google', 'hubspot'). */
  providers: string[];
  /** Subset of `providers` the signed-in user has not connected. */
  missingProviders: string[];
  /** Names of the agents whose allowed_tool_ids expose this tool. */
  agents: string[];
  agentSlugs: string[];
  /** Teams that deny this tool — admin-only detail, empty for everyone else. */
  restrictedFor: string[];
  /** True when at least one team denies this tool. */
  restrictedSomewhere: boolean;
  /** True when one of the signed-in user's own teams denies it. */
  deniedForMe: boolean;
  /** Which of MY teams block it, by name. */
  blockingTeams: string[];
  /** Env var names the deployment is missing. Names only, never values. */
  missingCredentials: string[];
  credentialLabel: string | null;
  credentialEffect: string | null;
  /** False when the tool degrades instead of dying without the credential. */
  credentialBlocking: boolean;
  /** Everything standing between the signed-in user and this tool. */
  blockedForMe: BlockReason[];
  usage: ToolUsage | null;
  serverId: string | null;
  serverName: string | null;
  /** Custom tools only: what the last test run said, when it failed. */
  lastError?: string | null;
  /** Custom tools only: whether the definition is switched on. */
  enabled?: boolean;
}

export interface ToolUsage {
  ok: number;
  errors: number;
  awaitingConfirmation: number;
  rateLimited: number;
  total: number;
  lastAt: string;
  lastStatus: string;
}

export interface CatalogTeam {
  id: string;
  name: string;
  memberCount: number;
}

export interface McpServerSummary {
  id: string;
  name: string;
  enabled: boolean;
  trusted: boolean;
  toolCount: number;
  lastError: string | null;
  lastCheckedAt: string | null;
}

export interface UsageMeta {
  available: boolean;
  windowDays: number;
  scanned: number;
  truncated: boolean;
  scanLimit: number;
  oldest: string | null;
  distinctTools: number;
}

const ICONS: Record<string, typeof Wrench> = {
  AlarmClock,
  BarChart3,
  BookOpen,
  Boxes,
  Building2,
  CalendarDays,
  Car,
  FileText,
  FolderOpen,
  GitBranch,
  Globe,
  Handshake,
  Inbox,
  Mail,
  MessageSquare,
  MessagesSquare,
  Mic,
  Server,
  ShieldCheck,
  Sparkles,
  SquareKanban,
  Table2,
  TrendingUp,
  Type,
  Users,
  Wallet,
  Workflow,
  Wrench,
};

const TONE_CHIP: Record<FamilyTone, string> = {
  primary: 'bg-primary-soft text-primary',
  emerald: 'bg-emerald-soft text-emerald',
  amber: 'bg-amber-soft text-amber',
  sky: 'bg-sky-soft text-sky',
  rose: 'bg-rose-soft text-rose',
};

const RISK_CHIP: Record<RiskLevel, string> = {
  low: 'border-border bg-surface-2 text-ink-muted',
  medium: 'border-sky/30 bg-sky-soft text-sky',
  high: 'border-amber/30 bg-amber-soft text-amber',
  critical: 'border-rose/30 bg-rose-soft text-rose',
};

const NEUTRAL_CHIP = 'border-border bg-surface-2 text-ink-muted';
const OK_CHIP = 'border-emerald/30 bg-emerald-soft text-emerald';
const WARN_CHIP = 'border-amber/30 bg-amber-soft text-amber';
const BLOCK_CHIP = 'border-rose/30 bg-rose-soft text-rose';

const BLOCK_ICON: Record<BlockReason, typeof Wrench> = {
  disabled: Power,
  not_granted: Bot,
  team_blocked: Lock,
  integration: PlugZap,
  credential: KeyRound,
};

/** Rose for what a person cannot lift themselves; amber for what they can. */
const BLOCK_TONE: Record<BlockReason, 'rose' | 'amber'> = {
  disabled: 'amber',
  not_granted: 'rose',
  team_blocked: 'rose',
  integration: 'amber',
  credential: 'rose',
};

type StateFilter = 'all' | 'ready' | 'blocked' | 'approval' | 'unused';

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/**
 * Small on/off switch used for both family and tool rows. A soft pill track
 * with a round thumb — the same shape a person would expect on any modern
 * settings screen, even though what it controls is a permissions sheet.
 */
function Toggle({
  on,
  disabled,
  label,
  onClick,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'relative h-5 w-9 shrink-0 rounded-pill border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        on ? 'border-emerald bg-emerald' : 'border-border bg-surface-2',
      )}
    >
      <span
        className={clsx(
          'absolute left-0.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border transition-transform motion-reduce:transition-none',
          on ? 'translate-x-4 border-emerald bg-surface' : 'border-border bg-surface',
        )}
      />
    </button>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[11.5px] font-semibold transition-all duration-150 hover:-translate-y-px motion-reduce:transform-none motion-reduce:transition-none',
        active
          ? 'border-primary bg-primary text-white'
          : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

/** A soft pill tag on the row: short label, bordered, and never a shadow. */
function Badge({
  className,
  icon: Icon,
  children,
  title,
}: {
  className: string;
  icon?: typeof Wrench;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-[10.5px] font-semibold',
        className,
      )}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Time formatting — Bogota, always, so two people reading the same screen in
// two cities are reading the same clock.
// ---------------------------------------------------------------------------

const BOGOTA = 'America/Bogota';

function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d
    .toLocaleString('es-CO', {
      timeZone: BOGOTA,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace(',', '');
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return 'hace un momento';
  if (mins < 60) return `hace ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 31) return `hace ${days} ${days === 1 ? 'día' : 'días'}`;
  const months = Math.round(days / 30);
  return `hace ${months} ${months === 1 ? 'mes' : 'meses'}`;
}

// ---------------------------------------------------------------------------

export function ToolsControlCentre({
  tools,
  isAdmin,
  teams,
  selectedTeamId,
  initialTeamDenied,
  mcpServers,
  agentCount,
  usageMeta,
}: {
  tools: CatalogTool[];
  isAdmin: boolean;
  teams: CatalogTeam[];
  selectedTeamId: string;
  /** Patterns the selected team denies (allowed = false rows). */
  initialTeamDenied: string[];
  mcpServers: McpServerSummary[];
  agentCount: number;
  usageMeta: UsageMeta;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<string>('all');
  const [state, setState] = useState<StateFilter>('all');
  const [cause, setCause] = useState<BlockReason | null>(null);
  const [risk, setRisk] = useState<'all' | RiskLevel>('all');
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [denied, setDenied] = useState<string[]>(initialTeamDenied);
  const [savingPattern, setSavingPattern] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<string | null>(null);

  // Re-sync whenever the server sends permissions for a (possibly different)
  // selected team.
  useEffect(() => {
    setDenied(initialTeamDenied);
  }, [initialTeamDenied]);

  // The "read at" on the usage stamp is client time on purpose: rendering it on
  // the server would freeze at build/render time and quietly claim the numbers
  // are fresher than they are. Set after mount so it never mismatches hydration.
  useEffect(() => {
    setNow(shortDateTime(new Date().toISOString()));
  }, []);

  const blockedTools = useMemo(() => tools.filter((t) => t.blockedForMe.length > 0), [tools]);
  const readyCount = tools.length - blockedTools.length;
  const approvalCount = tools.filter((t) => t.needsApproval).length;
  const usedCount = tools.filter((t) => t.usage).length;

  const causeCounts = useMemo(() => {
    const counts = new Map<BlockReason, CatalogTool[]>();
    for (const t of blockedTools) {
      // The one cause to lead with, in the order the runtime actually hits them.
      const reason = BLOCK_ORDER.find((r) => t.blockedForMe.includes(r));
      if (!reason) continue;
      const list = counts.get(reason) ?? [];
      list.push(t);
      counts.set(reason, list);
    }
    return counts;
  }, [blockedTools]);

  const filtersActive =
    query.trim() !== '' || group !== 'all' || state !== 'all' || cause !== null || risk !== 'all';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tools.filter((t) => {
      if (group !== 'all' && t.group !== group) return false;
      if (state === 'ready' && t.blockedForMe.length > 0) return false;
      if (state === 'blocked' && t.blockedForMe.length === 0) return false;
      if (state === 'approval' && !t.needsApproval) return false;
      if (state === 'unused' && t.usage) return false;
      if (cause && !t.blockedForMe.includes(cause)) return false;
      if (risk !== 'all' && t.riskLevel !== risk) return false;
      if (!q) return true;
      const meta = familyMeta(t.family);
      const groupName = groupMeta(t.group).name;
      return (
        t.id.toLowerCase().includes(q) ||
        t.title.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        meta.name.toLowerCase().includes(q) ||
        meta.blurb.toLowerCase().includes(q) ||
        groupName.toLowerCase().includes(q) ||
        (t.serverName ?? '').toLowerCase().includes(q)
      );
    });
  }, [tools, query, group, state, cause, risk]);

  /** Group → family → tools, both in a stable declared order. */
  const grouped = useMemo(() => {
    const byGroup = new Map<string, Map<string, CatalogTool[]>>();
    for (const t of filtered) {
      const families = byGroup.get(t.group) ?? new Map<string, CatalogTool[]>();
      const list = families.get(t.family) ?? [];
      list.push(t);
      families.set(t.family, list);
      byGroup.set(t.group, families);
    }
    return [...byGroup.entries()]
      .sort(([a], [b]) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b))
      .map(
        ([id, families]) =>
          [
            id,
            [...families.entries()].sort(([a], [b]) =>
              familyMeta(a).name.localeCompare(familyMeta(b).name, 'es'),
            ),
          ] as const,
      );
  }, [filtered]);

  /** Per-group tallies for the overview cards — over ALL tools, not the filter. */
  const groupStats = useMemo(() => {
    const stats = new Map<string, { total: number; blocked: number }>();
    for (const t of tools) {
      const entry = stats.get(t.group) ?? { total: 0, blocked: 0 };
      entry.total += 1;
      if (t.blockedForMe.length > 0) entry.blocked += 1;
      stats.set(t.group, entry);
    }
    return stats;
  }, [tools]);

  const selectedTeam = isAdmin ? (teams.find((t) => t.id === selectedTeamId) ?? null) : null;
  const deniedSet = useMemo(() => new Set(denied), [denied]);
  const allOpen = grouped.length > 0 && grouped.every(([id]) => openGroups.has(id));

  // A search or filter is a request to see what matched — collapsed sections
  // would hide exactly the thing the person just asked for.
  const isOpen = (id: string) => filtersActive || openGroups.has(id);

  function toggleGroup(id: string) {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearFilters() {
    setQuery('');
    setGroup('all');
    setState('all');
    setCause(null);
    setRisk('all');
  }

  function focusGroup(id: string) {
    setCause(null);
    setState('all');
    setGroup((prev) => (prev === id ? 'all' : id));
  }

  function selectTeam(id: string) {
    setError(null);
    startTransition(() => {
      router.replace(id ? `/tools?team=${encodeURIComponent(id)}` : '/tools', { scroll: false });
    });
  }

  /** allowed=false writes a block, allowed=true clears it. */
  async function setPermission(pattern: string, allowed: boolean) {
    if (!selectedTeam || savingPattern) return;
    const prev = denied;
    setError(null);
    setSavingPattern(pattern);
    setDenied(allowed ? prev.filter((p) => p !== pattern) : [...new Set([...prev, pattern])]);
    try {
      const res = await fetch('/api/tools/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: selectedTeam.id, toolPattern: pattern, allowed }),
      });
      if (!res.ok) throw new Error('save failed');
    } catch {
      setDenied(prev);
      setError('No se pudo guardar el cambio. Inténtalo de nuevo.');
    } finally {
      setSavingPattern(null);
    }
  }

  const stats = [
    {
      label: 'Herramientas',
      value: tools.length,
      sub: 'en el registro y en tus servidores',
      icon: Wrench,
      tone: 'text-ink',
      onClick: () => clearFilters(),
    },
    {
      label: 'Listas para ti',
      value: readyCount,
      sub: 'Cortex puede usarlas ahora mismo',
      icon: CircleCheck,
      tone: readyCount > 0 ? 'text-emerald' : 'text-ink',
      onClick: () => {
        clearFilters();
        setState('ready');
      },
    },
    {
      label: 'Frenadas',
      value: blockedTools.length,
      sub: blockedTools.length > 0 ? 'algo las está deteniendo' : 'nada está frenado',
      icon: TriangleAlert,
      tone: blockedTools.length > 0 ? 'text-rose' : 'text-emerald',
      onClick: () => {
        clearFilters();
        setState('blocked');
      },
    },
    {
      label: 'Piden confirmación',
      value: approvalCount,
      sub: 'una persona aprueba primero',
      icon: ShieldAlert,
      tone: approvalCount > 0 ? 'text-amber' : 'text-ink',
      onClick: () => {
        clearFilters();
        setState('approval');
      },
    },
    {
      label: 'Usadas',
      value: usageMeta.available ? usedCount : '—',
      sub: usageMeta.available
        ? `distintas, en ${usageMeta.windowDays} días`
        : 'no se pudo leer la auditoría',
      icon: Clock3,
      tone: 'text-ink',
      onClick: () => {
        clearFilters();
        setState('unused');
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* --- 1. The inventory line ------------------------------------------
          Hairlines come from the gap showing the border colour through, so the
          rules stay correct at every breakpoint the grid reflows to. */}
      <Panel className="overflow-hidden">
        <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={s.onClick}
              className="bg-surface p-4 text-left transition-colors hover:bg-surface-2 motion-reduce:transition-none"
            >
              <div className="flex items-center gap-1.5">
                <s.icon className={`h-3.5 w-3.5 ${s.tone}`} />
                <span className="field-label">{s.label}</span>
              </div>
              <div className={`stat-num mt-1.5 text-[26px] leading-none ${s.tone}`}>{s.value}</div>
              <div className="mt-1.5 text-[11px] leading-snug text-ink-faint">{s.sub}</div>
            </button>
          ))}
        </div>
      </Panel>

      {/* --- 2. What Cortex knows how to do -------------------------------- */}
      <Panel className="p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 className="text-[14px] font-bold text-ink">Qué sabe hacer Cortex</h2>
            <p className="mt-0.5 text-[12px] leading-snug text-ink-muted">
              Agrupado por lo que resuelve, no por el sistema que hay detrás. Toca un grupo para ver
              solo esas herramientas.
            </p>
          </div>
          {group !== 'all' && (
            <Button type="button" variant="ghost" onClick={() => setGroup('all')}>
              Ver todos los grupos
            </Button>
          )}
        </div>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITY_GROUPS.filter((g) => (groupStats.get(g.id)?.total ?? 0) > 0).map((g) => {
            const Icon = ICONS[g.icon] ?? Wrench;
            const s = groupStats.get(g.id) ?? { total: 0, blocked: 0 };
            const active = group === g.id;
            return (
              <button
                key={g.id}
                type="button"
                onClick={() => focusGroup(g.id)}
                aria-pressed={active}
                className={clsx(
                  'flex items-start gap-3 rounded-card border p-3 text-left transition-all duration-150 hover:-translate-y-px motion-reduce:transform-none motion-reduce:transition-none',
                  active
                    ? 'border-primary bg-primary-soft shadow-card'
                    : 'border-border bg-surface hover:border-border-strong hover:bg-surface-2',
                )}
              >
                <span
                  className={clsx(
                    'grid h-9 w-9 shrink-0 place-items-center rounded-card',
                    TONE_CHIP[g.tone],
                  )}
                >
                  <Icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-bold text-ink">{g.name}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-muted">
                    {g.blurb}
                  </span>
                  <span className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[10.5px]">
                    <span className="text-ink-faint">
                      <span className="tabular">{s.total - s.blocked}</span> listas
                    </span>
                    {s.blocked > 0 && (
                      <span className="font-semibold text-rose">
                        <span className="tabular">{s.blocked}</span> frenadas
                      </span>
                    )}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </Panel>

      {/* --- 3. Why it did not do what you asked --------------------------- */}
      <Panel className="p-4">
        <div className="flex items-start gap-3">
          <span
            className={clsx(
              'grid h-8 w-8 shrink-0 place-items-center rounded-card',
              blockedTools.length > 0 ? 'bg-rose-soft text-rose' : 'bg-emerald-soft text-emerald',
            )}
          >
            {blockedTools.length > 0 ? (
              <TriangleAlert className="h-4 w-4" />
            ) : (
              <CircleCheck className="h-4 w-4" />
            )}
          </span>
          <div className="min-w-0">
            <h2 className="text-[14px] font-bold text-ink">Por qué no hizo lo que le pediste</h2>
            <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
              {blockedTools.length > 0 ? (
                <>
                  <span className="tabular font-semibold text-ink">{blockedTools.length}</span> de{' '}
                  <span className="tabular">{tools.length}</span> herramientas no están disponibles
                  para ti ahora mismo. Cortex no te avisa cuando le falta una: simplemente responde
                  con lo que sí alcanza. Estas son las causas.
                </>
              ) : (
                'Todo lo que esta organización tiene habilitado está disponible para ti. Si Cortex no hizo algo, no fue por permisos ni por una integración: revisa la Auditoría para ver qué se ejecutó de verdad.'
              )}
            </p>
          </div>
        </div>

        {blockedTools.length > 0 && (
          <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
            {BLOCK_ORDER.filter((reason) => (causeCounts.get(reason)?.length ?? 0) > 0).map(
              (reason) => {
                const list = causeCounts.get(reason) ?? [];
                const Icon = BLOCK_ICON[reason];
                const tone = BLOCK_TONE[reason];
                const active = cause === reason;
                return (
                  <div
                    key={reason}
                    className={clsx(
                      'rounded-card border p-3',
                      active ? 'border-primary bg-primary-soft' : 'border-border bg-surface-2',
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <span
                        className={clsx(
                          'grid h-7 w-7 shrink-0 place-items-center rounded-sm',
                          tone === 'rose' ? 'bg-rose-soft text-rose' : 'bg-amber-soft text-amber',
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="text-[12.5px] font-bold text-ink">
                            {BLOCK_LABEL[reason]}
                          </span>
                          <span
                            className={clsx(
                              'tabular text-[11px] font-semibold',
                              tone === 'rose' ? 'text-rose' : 'text-amber',
                            )}
                          >
                            {list.length}
                          </span>
                        </div>
                        <p className="mt-0.5 text-[11.5px] leading-snug text-ink-muted">
                          {BLOCK_BLURB[reason]}
                        </p>
                        <CauseDetail
                          reason={reason}
                          tools={list}
                          isAdmin={isAdmin}
                          agentCount={agentCount}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setCause(active ? null : reason);
                            setGroup('all');
                            setState('all');
                          }}
                          aria-pressed={active}
                          className="mt-2 text-[11.5px] font-semibold text-primary hover:underline"
                        >
                          {active ? 'Quitar este filtro' : 'Ver cuáles son'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              },
            )}
          </div>
        )}
      </Panel>

      {/* --- 4. What is switched on (admins) ------------------------------- */}
      {isAdmin && (
        <Panel className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid h-8 w-8 place-items-center rounded-card bg-primary-soft text-primary">
              <UsersRound className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ink">Qué está encendido</div>
              <div className="text-[11.5px] leading-relaxed text-ink-faint">
                El acceso se da por equipo, nunca por persona. Escoge un equipo y usa los
                interruptores de abajo para bloquear grupos enteros o herramientas sueltas.
              </div>
            </div>
            <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
              <select
                value={selectedTeamId}
                onChange={(e) => selectTeam(e.target.value)}
                aria-label="Equipo cuyos permisos vas a editar"
                className="w-full rounded-sm border border-border bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary sm:w-auto sm:min-w-[240px]"
              >
                <option value="">Solo mirar — sin equipo seleccionado</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {selectedTeam && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-pill border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-ink-muted">
                  <Users2 className="h-3 w-3" />
                  <span className="tabular">{selectedTeam.memberCount}</span>{' '}
                  {selectedTeam.memberCount === 1 ? 'persona' : 'personas'}
                </span>
              )}
            </div>
          </div>
          {selectedTeam && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-faint">
              Los interruptores controlan qué puede usar{' '}
              <span className="font-semibold text-ink-muted">{selectedTeam.name}</span>. Apagado
              bloquea la herramienta para todo el equipo; encendido quita el bloqueo y vuelve a lo
              que permita el agente. Los equipos solo restan: otro equipo no puede devolver lo que
              este bloquea.
              {isPending && <span className="ml-2 text-primary">Cargando los permisos…</span>}
            </p>
          )}
          {teams.length === 0 && (
            <p className="mt-2 text-[11.5px] text-ink-faint">
              Todavía no hay equipos a los que darles acceso.{' '}
              <Link href="/admin/teams" className="font-semibold text-primary hover:underline">
                Crea uno en Equipos
              </Link>{' '}
              y vuelve acá.
            </p>
          )}
          {error && (
            <p className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-[11.5px] font-semibold text-rose">
              {error}
            </p>
          )}
        </Panel>
      )}

      {/* --- 5. Search and filters ----------------------------------------- */}
      <Panel className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative flex min-w-[240px] flex-1 items-center">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-ink-faint" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Busca por nombre, por lo que hace o por el sistema que toca…"
              className="h-9 w-full rounded-sm border border-border bg-surface-2 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary focus:bg-surface"
            />
          </label>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpenGroups(allOpen ? new Set() : new Set(grouped.map(([id]) => id)))}
            disabled={filtersActive}
          >
            {allOpen ? 'Contraer todo' : 'Expandir todo'}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="field-label mr-1">Estado</span>
          <FilterChip
            active={state === 'ready'}
            onClick={() => setState(state === 'ready' ? 'all' : 'ready')}
          >
            <CircleCheck className="h-3 w-3" />
            Listas para ti
          </FilterChip>
          <FilterChip
            active={state === 'blocked'}
            onClick={() => setState(state === 'blocked' ? 'all' : 'blocked')}
          >
            <TriangleAlert className="h-3 w-3" />
            Frenadas
          </FilterChip>
          <FilterChip
            active={state === 'approval'}
            onClick={() => setState(state === 'approval' ? 'all' : 'approval')}
          >
            <ShieldAlert className="h-3 w-3" />
            Piden confirmación
          </FilterChip>
          <FilterChip
            active={state === 'unused'}
            onClick={() => setState(state === 'unused' ? 'all' : 'unused')}
          >
            <Clock3 className="h-3 w-3" />
            Nunca usadas
          </FilterChip>

          <span className="mx-1 h-4 w-px bg-border" />
          <span className="field-label mr-1">Riesgo</span>
          {(['all', 'low', 'medium', 'high', 'critical'] as const).map((level) => (
            <FilterChip key={level} active={risk === level} onClick={() => setRisk(level)}>
              {level === 'all' ? 'Cualquiera' : RISK_LABEL[level]}
            </FilterChip>
          ))}

          {filtersActive && (
            <>
              <span className="mx-1 h-4 w-px bg-border" />
              <Button type="button" variant="ghost" onClick={clearFilters}>
                Quitar los filtros
              </Button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="max-w-3xl text-[11px] leading-relaxed text-ink-faint">
            El riesgo es la línea base que la capa de seguridad le asigna a cada herramienta según
            qué toca y hasta dónde llega. La llamada real puede puntuar más alto: cifras de sueldos
            en los datos, un destinatario fuera de la empresa o una exportación masiva la suben.
            Solo las combinaciones de verdad peligrosas se rechazan de plano; todo lo demás corre y
            queda registrado.
          </p>
          {usageMeta.available && now && (
            <Provenance
              source="Auditoría"
              readAt={now}
              detail={
                usageMeta.truncated
                  ? `${usageMeta.scanLimit.toLocaleString('es-CO')} eventos${usageMeta.oldest ? ` · desde ${shortDateTime(usageMeta.oldest)}` : ''}`
                  : `${usageMeta.windowDays} días · ${usageMeta.scanned.toLocaleString('es-CO')} eventos`
              }
            />
          )}
        </div>
        {usageMeta.available && usageMeta.truncated && (
          <p className="text-[11px] leading-relaxed text-ink-faint">
            El uso se calcula leyendo los{' '}
            <span className="tabular">{usageMeta.scanLimit.toLocaleString('es-CO')}</span> eventos
            más recientes, no los {usageMeta.windowDays} días completos: esta organización los pasó.
            Los conteos de abajo son de{' '}
            {usageMeta.oldest ? shortDateTime(usageMeta.oldest) : 'ese tramo'} en adelante.{' '}
            <Link href="/admin/audit" className="font-semibold text-primary hover:underline">
              La Auditoría tiene el registro completo
            </Link>
            .
          </p>
        )}
      </Panel>

      {/* --- 6. The catalogue ---------------------------------------------- */}
      {grouped.length === 0 ? (
        <Panel className="p-10 text-center">
          <p className="mx-auto max-w-sm text-[13px] leading-relaxed text-ink-muted">
            Ninguna herramienta coincide con esta búsqueda y estos filtros. Amplía la búsqueda o
            quita lo que tengas puesto.
          </p>
          <Button type="button" variant="outline" className="mt-4" onClick={clearFilters}>
            Quitar los filtros
          </Button>
        </Panel>
      ) : (
        <div className="flex flex-col gap-3">
          {grouped.map(([groupId, families]) => {
            const meta = groupMeta(groupId);
            const Icon = ICONS[meta.icon] ?? Wrench;
            const open = isOpen(groupId);
            const list = families.flatMap(([, items]) => items);
            const blocked = list.filter((t) => t.blockedForMe.length > 0).length;
            const approvals = list.filter((t) => t.needsApproval).length;

            return (
              <Panel key={groupId} className="overflow-hidden">
                <button
                  type="button"
                  onClick={() => toggleGroup(groupId)}
                  aria-expanded={open}
                  className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-surface-2 motion-reduce:transition-none"
                >
                  <span
                    className={clsx(
                      'grid h-9 w-9 shrink-0 place-items-center rounded-card',
                      TONE_CHIP[meta.tone],
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-[14px] font-bold text-ink">{meta.name}</span>
                      <span className="text-[10.5px] text-ink-faint">
                        <span className="tabular">{list.length}</span>{' '}
                        {list.length === 1 ? 'herramienta' : 'herramientas'}
                      </span>
                      {approvals > 0 && (
                        <span className="text-[10.5px] font-semibold text-amber">
                          <span className="tabular">{approvals}</span> piden confirmación
                        </span>
                      )}
                      {blocked > 0 && (
                        <span className="text-[10.5px] font-semibold text-rose">
                          <span className="tabular">{blocked}</span> frenadas
                        </span>
                      )}
                    </span>
                    <span className="mt-0.5 block text-[12px] leading-snug text-ink-muted">
                      {meta.blurb}
                    </span>
                  </span>
                  <ChevronDown
                    className={clsx(
                      'mt-1 h-4 w-4 shrink-0 text-ink-faint transition-transform motion-reduce:transition-none',
                      open && 'rotate-180',
                    )}
                  />
                </button>

                {open && (
                  <div className="border-t border-border">
                    {families.map(([family, items]) => (
                      <FamilyBlock
                        key={family}
                        family={family}
                        items={items}
                        showHeader={families.length > 1 || groupId === 'mcp'}
                        server={
                          groupId === 'mcp'
                            ? (mcpServers.find((s) => `mcp:${s.id}` === family) ?? null)
                            : null
                        }
                        selectedTeam={selectedTeam}
                        deniedSet={deniedSet}
                        savingPattern={savingPattern}
                        setPermission={setPermission}
                        isAdmin={isAdmin}
                        usageAvailable={usageMeta.available}
                      />
                    ))}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      )}

      {/* --- 7. Tools this company wrote itself ----------------------------
          Its own data source: the definitions live in `custom_tools` and the
          panel edits and TESTS them live, so it owns its fetch rather than
          taking a snapshot as a prop. */}
      <CustomTools />
    </div>
  );
}

// ---------------------------------------------------------------------------
// What to do about each cause
// ---------------------------------------------------------------------------

function CauseDetail({
  reason,
  tools,
  isAdmin,
  agentCount,
}: {
  reason: BlockReason;
  tools: CatalogTool[];
  isAdmin: boolean;
  agentCount: number;
}) {
  if (reason === 'disabled') {
    return (
      <p className="mt-1.5 text-[11.5px] leading-snug text-ink">
        {tools.map((t) => t.title).join(', ')}{' '}
        {tools.length === 1 ? 'está apagada' : 'están apagadas'}.{' '}
        {isAdmin ? (
          <a href="#herramientas-propias" className="font-semibold text-primary hover:underline">
            Enciéndela abajo, en Herramientas propias
          </a>
        ) : (
          'Un administrador puede volver a encenderla.'
        )}
      </p>
    );
  }

  if (reason === 'integration') {
    const providers = [...new Set(tools.flatMap((t) => t.missingProviders))].sort();
    return (
      <p className="mt-1.5 text-[11.5px] leading-snug text-ink">
        Falta conectar {providers.map(providerLabel).join(', ')}.{' '}
        <Link href="/integrations" className="font-semibold text-primary hover:underline">
          Conéctalo en Integraciones
        </Link>{' '}
        — toma menos de un minuto y lo haces tú.
      </p>
    );
  }

  if (reason === 'team_blocked') {
    const teams = [...new Set(tools.flatMap((t) => t.blockingTeams))].sort();
    return (
      <p className="mt-1.5 text-[11.5px] leading-snug text-ink">
        {teams.length > 0 ? (
          <>
            Lo bloqueó {teams.length === 1 ? 'tu equipo' : 'tus equipos'}{' '}
            <span className="font-semibold">{teams.join(', ')}</span>.{' '}
          </>
        ) : (
          'Uno de tus equipos lo bloqueó. '
        )}
        {isAdmin
          ? 'Escoge ese equipo arriba y vuelve a encender lo que necesites.'
          : 'Solo un administrador puede levantarlo.'}
      </p>
    );
  }

  if (reason === 'credential') {
    const vars = [...new Set(tools.flatMap((t) => t.missingCredentials))].sort();
    return (
      <p className="mt-1.5 text-[11.5px] leading-snug text-ink">
        {isAdmin ? (
          <>
            Al servidor le falta <span className="tabular font-semibold">{vars.join(', ')}</span>.
            No se configura desde la app: alguien de infraestructura tiene que ponerla en el
            entorno.
          </>
        ) : (
          'Depende de una llave que se configura en el servidor. Pídesela a quien administra Cortex; no hay nada que puedas hacer desde acá.'
        )}
      </p>
    );
  }

  // not_granted
  if (agentCount === 0) {
    return (
      <p className="mt-1.5 text-[11.5px] leading-snug text-ink">
        Esta organización no tiene ningún agente activo, así que ninguna herramienta le llega al
        modelo.
      </p>
    );
  }
  return (
    <p className="mt-1.5 text-[11.5px] leading-snug text-ink">
      Están en el registro, pero ningún agente activo las lista.{' '}
      {isAdmin ? (
        <>
          <Link href="/agents" className="font-semibold text-primary hover:underline">
            Habilítalas en el agente
          </Link>{' '}
          que deba usarlas.
        </>
      ) : (
        'Un administrador tiene que habilitarlas en el agente.'
      )}
    </p>
  );
}

// ---------------------------------------------------------------------------
// One family inside a capability group
// ---------------------------------------------------------------------------

function FamilyBlock({
  family,
  items,
  showHeader,
  server,
  selectedTeam,
  deniedSet,
  savingPattern,
  setPermission,
  isAdmin,
  usageAvailable,
}: {
  family: string;
  items: CatalogTool[];
  showHeader: boolean;
  server: McpServerSummary | null;
  selectedTeam: CatalogTeam | null;
  deniedSet: Set<string>;
  savingPattern: string | null;
  setPermission: (pattern: string, allowed: boolean) => void;
  isAdmin: boolean;
  usageAvailable: boolean;
}) {
  const isMcp = family.startsWith('mcp:');
  const meta = familyMeta(family);
  const familyPattern = `${family}.*`;
  const familyBlocked = deniedSet.has(familyPattern);

  return (
    <div>
      {showHeader && (
        <div className="flex items-center gap-3 border-b border-border bg-surface-2 px-4 py-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[12px] font-bold text-ink">
                {isMcp ? (server?.name ?? 'Servidor MCP') : meta.name}
              </span>
              {!isMcp && (
                <code className="tabular text-[10.5px] text-ink-faint">{familyPattern}</code>
              )}
              {isMcp && server && (
                <span
                  className={clsx(
                    'text-[10.5px] font-semibold',
                    server.trusted ? 'text-emerald' : 'text-amber',
                  )}
                >
                  {server.trusted ? 'De confianza' : 'Pregunta antes de cada llamada'}
                </span>
              )}
            </div>
            {isMcp && server?.lastError && (
              <p className="mt-0.5 text-[11px] leading-snug text-rose">
                Última revisión con error: {server.lastError}
              </p>
            )}
          </div>
          {isMcp ? (
            <Link
              href="/integrations"
              className="shrink-0 text-[11.5px] font-semibold text-primary hover:underline"
            >
              Administrar servidor
            </Link>
          ) : (
            selectedTeam && (
              <div className="flex shrink-0 items-center gap-2">
                <span
                  className={clsx(
                    'text-[10.5px] font-semibold',
                    familyBlocked ? 'text-rose' : 'text-ink-faint',
                  )}
                >
                  {familyBlocked ? 'Familia bloqueada' : 'Toda la familia'}
                </span>
                <Toggle
                  on={!familyBlocked}
                  disabled={savingPattern === familyPattern}
                  label={`${familyBlocked ? 'Permitir' : 'Bloquear'} toda la familia ${meta.name} para ${selectedTeam.name}`}
                  onClick={() => setPermission(familyPattern, familyBlocked)}
                />
              </div>
            )
          )}
        </div>
      )}

      {items.map((t, i) => (
        <ToolRow
          key={t.id}
          tool={t}
          first={i === 0}
          selectedTeam={selectedTeam}
          deniedSet={deniedSet}
          familyBlocked={familyBlocked}
          savingPattern={savingPattern}
          setPermission={setPermission}
          isAdmin={isAdmin}
          usageAvailable={usageAvailable}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One tool
// ---------------------------------------------------------------------------

function ToolRow({
  tool: t,
  first,
  selectedTeam,
  deniedSet,
  familyBlocked,
  savingPattern,
  setPermission,
  isAdmin,
  usageAvailable,
}: {
  tool: CatalogTool;
  first: boolean;
  selectedTeam: CatalogTeam | null;
  deniedSet: Set<string>;
  familyBlocked: boolean;
  savingPattern: string | null;
  setPermission: (pattern: string, allowed: boolean) => void;
  isAdmin: boolean;
  usageAvailable: boolean;
}) {
  const toolBlocked = deniedSet.has(t.id);
  const teamBlocked = toolBlocked || familyBlocked;
  const reason = BLOCK_ORDER.find((r) => t.blockedForMe.includes(r)) ?? null;
  const unavailable = selectedTeam ? teamBlocked : t.blockedForMe.length > 0;

  return (
    <div className={clsx('flex items-start gap-4 px-4 py-3', !first && 'border-t border-border')}>
      <div className="min-w-0 flex-1">
        <div className={clsx(unavailable && 'opacity-70')}>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className="text-[13.5px] font-semibold text-ink"
              title={t.kind === 'registry' ? qualifiedToolLabel(t.id) : t.title}
            >
              {t.title}
            </span>
            {/* Raw id kept as secondary detail: it is what the permission
                patterns and the audit log speak. */}
            <code className="tabular text-[11px] text-ink-faint">{t.id}</code>
          </div>
          <p className="mt-0.5 text-[12.5px] leading-snug text-ink-muted">{t.description}</p>
        </div>

        {/* The answer to "why didn't it work", on the row itself. */}
        {reason && (
          <div
            className={clsx(
              'mt-1.5 flex items-start gap-2 rounded-sm border px-2.5 py-1.5',
              BLOCK_TONE[reason] === 'rose'
                ? 'border-rose/30 bg-rose-soft'
                : 'border-amber/30 bg-amber-soft',
            )}
          >
            {(() => {
              const Icon = BLOCK_ICON[reason];
              return (
                <Icon
                  className={clsx(
                    'mt-0.5 h-3.5 w-3.5 shrink-0',
                    BLOCK_TONE[reason] === 'rose' ? 'text-rose' : 'text-amber',
                  )}
                />
              );
            })()}
            <p
              className={clsx(
                'text-[11.5px] leading-snug',
                BLOCK_TONE[reason] === 'rose' ? 'text-rose' : 'text-amber',
              )}
            >
              <RowReason tool={t} reason={reason} isAdmin={isAdmin} />
            </p>
          </div>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {t.riskLevel ? (
            <Badge
              className={RISK_CHIP[t.riskLevel]}
              title={[
                t.sensitivity && t.blastRadius
                  ? `${SENSITIVITY_LABEL[t.sensitivity]} · ${BLAST_LABEL[t.blastRadius]}`
                  : null,
                t.outboundRiskLevel
                  ? `Sube a ${RISK_LABEL[t.outboundRiskLevel].toLowerCase()} cuando va dirigida por fuera de la empresa`
                  : null,
              ]
                .filter(Boolean)
                .join(' — ')}
            >
              {RISK_LABEL[t.riskLevel]}
              {t.outboundRiskLevel ? ' +' : ''}
            </Badge>
          ) : (
            <Badge
              className={NEUTRAL_CHIP}
              icon={Server}
              title="Las herramientas de un servidor MCP no pasan por el clasificador de riesgo de Cortex: las llama directo el chat."
            >
              Sin clasificar
            </Badge>
          )}
          {t.sensitivity && (
            <Badge className={NEUTRAL_CHIP}>{SENSITIVITY_LABEL[t.sensitivity]}</Badge>
          )}
          {t.canLeaveCompany ? (
            <Badge
              className={BLOCK_CHIP}
              icon={Send}
              title={
                t.outboundRiskLevel
                  ? `Puntúa ${RISK_LABEL[t.outboundRiskLevel].toLowerCase()} apenas va dirigida a alguien fuera de la empresa`
                  : 'El contenido llega a gente fuera de la empresa'
              }
            >
              Puede salir de la empresa
            </Badge>
          ) : (
            t.blastRadius && <Badge className={NEUTRAL_CHIP}>{BLAST_LABEL[t.blastRadius]}</Badge>
          )}
          {t.needsApproval ? (
            <Badge className={WARN_CHIP} icon={ShieldAlert}>
              Pide confirmación
            </Badge>
          ) : (
            <Badge className={OK_CHIP}>Corre sin confirmar</Badge>
          )}
          {t.providers.map((p) => {
            const missing = t.missingProviders.includes(p);
            return (
              <Badge
                key={p}
                icon={PlugZap}
                className={missing ? WARN_CHIP : OK_CHIP}
                title={
                  missing
                    ? `${providerLabel(p)} no está conectado en tu cuenta. Conéctalo en Integraciones`
                    : `${providerLabel(p)} está conectado`
                }
              >
                {providerLabel(p)}
                {missing ? ' sin conectar' : ''}
              </Badge>
            );
          })}
          {t.ratePerMinute != null && (
            <Badge
              className={clsx(NEUTRAL_CHIP, 'tabular')}
              icon={Gauge}
              title="Tope de llamadas por persona, por minuto"
            >
              {t.ratePerMinute}/min
            </Badge>
          )}
          {t.agents.map((name) => (
            <Badge
              key={name}
              className="border-primary/30 bg-primary-soft text-primary"
              icon={Bot}
              title={`Lo expone el agente ${name}`}
            >
              {name}
            </Badge>
          ))}
          {t.restrictedFor.length > 0 ? (
            <Badge
              className={BLOCK_CHIP}
              icon={Lock}
              title={`Bloqueada para ${t.restrictedFor.join(', ')}`}
            >
              Bloqueada para {t.restrictedFor.join(', ')}
            </Badge>
          ) : (
            isAdmin &&
            t.kind === 'registry' && (
              <Badge className={NEUTRAL_CHIP} icon={Users2}>
                Todos los equipos
              </Badge>
            )
          )}
          {/* A credential that only degrades the tool is not a block; it still
              has to be said, because the answer will be quietly worse. */}
          {t.missingCredentials.length > 0 && !t.credentialBlocking && (
            <Badge className={WARN_CHIP} icon={KeyRound} title={t.credentialEffect ?? undefined}>
              Funciona a medias
            </Badge>
          )}
          {/* The only "does this really work" evidence a row can carry: what
              the tester recorded the last time somebody ran it. */}
          {t.lastError && (
            <Badge className={BLOCK_CHIP} icon={FlaskConical} title={t.lastError}>
              La última prueba falló
            </Badge>
          )}
        </div>

        {usageAvailable && <UsageLine usage={t.usage} />}

        {t.needsApproval && t.approvalReason && (
          <p className="mt-1.5 border-l-2 border-amber/40 pl-2 text-[11.5px] leading-snug text-ink-faint">
            {t.approvalReason}
          </p>
        )}
      </div>

      {selectedTeam && t.kind === 'registry' && (
        <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
          <Toggle
            on={!teamBlocked}
            disabled={familyBlocked || savingPattern === t.id}
            label={`${teamBlocked ? 'Permitir' : 'Bloquear'} ${qualifiedToolLabel(t.id)} para ${selectedTeam.name}`}
            onClick={() => setPermission(t.id, toolBlocked)}
          />
          {familyBlocked ? (
            <span className="text-[10.5px] font-semibold text-rose">Por familia</span>
          ) : (
            toolBlocked && <span className="text-[10.5px] font-semibold text-rose">Bloqueada</span>
          )}
        </div>
      )}
    </div>
  );
}

/** The one sentence that says what to do about THIS tool. */
function RowReason({
  tool: t,
  reason,
  isAdmin,
}: {
  tool: CatalogTool;
  reason: BlockReason;
  isAdmin: boolean;
}) {
  if (reason === 'disabled') {
    return (
      <>
        Está apagada, así que no se le ofrece al modelo.{' '}
        {isAdmin ? (
          <a href="#herramientas-propias" className="font-semibold underline">
            Encenderla
          </a>
        ) : (
          'Un administrador puede encenderla.'
        )}
      </>
    );
  }
  if (reason === 'integration') {
    return (
      <>
        Necesita {t.missingProviders.map(providerLabel).join(' y ')} y tu cuenta no lo tiene
        conectado.{' '}
        <Link href="/integrations" className="font-semibold underline">
          Conectar ahora
        </Link>
      </>
    );
  }
  if (reason === 'team_blocked') {
    return (
      <>
        {t.blockingTeams.length > 0
          ? `${t.blockingTeams.join(', ')} la tiene bloqueada para sus integrantes.`
          : 'Uno de tus equipos la tiene bloqueada.'}{' '}
        {isAdmin
          ? 'Escoge ese equipo arriba para levantarlo.'
          : 'Pídele a un administrador que la habilite.'}
      </>
    );
  }
  if (reason === 'credential') {
    return (
      <>
        Le falta {t.credentialLabel ?? 'una credencial'} al servidor
        {isAdmin && t.missingCredentials.length > 0 ? (
          <>
            {' '}
            (<span className="tabular">{t.missingCredentials.join(', ')}</span>)
          </>
        ) : null}
        . {t.credentialEffect ?? ''}
      </>
    );
  }
  return (
    <>
      Ningún agente activo la tiene habilitada, así que Cortex nunca la ve.{' '}
      {isAdmin ? (
        <Link href="/agents" className="font-semibold underline">
          Habilitarla en un agente
        </Link>
      ) : (
        'Un administrador puede habilitarla en el agente.'
      )}
    </>
  );
}

/** Last run, how often, and whether anything failed. */
function UsageLine({ usage }: { usage: ToolUsage | null }) {
  // "hace 4 min" is computed from the clock, so rendering it during SSR and
  // again at hydration can disagree across a minute boundary. The absolute
  // stamp beside it is deterministic and carries the fact on its own.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!usage) {
    return <p className="mt-1.5 text-[11px] text-ink-faint">Nunca se ha usado.</p>;
  }
  const failures = usage.errors + usage.rateLimited;
  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-faint">
      <span>
        Última vez{' '}
        {mounted && (
          <span className="font-semibold text-ink-muted">{relativeTime(usage.lastAt)}</span>
        )}{' '}
        <span className="tabular">{shortDateTime(usage.lastAt)}</span>
      </span>
      <span aria-hidden className="opacity-40">
        ·
      </span>
      <span>
        <span className="tabular font-semibold text-ink-muted">{usage.total}</span>{' '}
        {usage.total === 1 ? 'llamada' : 'llamadas'}
      </span>
      {failures > 0 && (
        <>
          <span aria-hidden className="opacity-40">
            ·
          </span>
          <span className="font-semibold text-rose">
            <span className="tabular">{failures}</span> {failures === 1 ? 'falló' : 'fallaron'}
          </span>
        </>
      )}
      {usage.awaitingConfirmation > 0 && (
        <>
          <span aria-hidden className="opacity-40">
            ·
          </span>
          <span className="font-semibold text-amber">
            <span className="tabular">{usage.awaitingConfirmation}</span> quedaron esperando
            aprobación
          </span>
        </>
      )}
    </p>
  );
}
