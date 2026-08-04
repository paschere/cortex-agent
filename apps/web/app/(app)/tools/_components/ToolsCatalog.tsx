'use client';

import { Panel } from '@/components/ui/panel';
import {
  BLAST_LABEL,
  type BlastRadius,
  type FamilyTone,
  RISK_LABEL,
  type RiskLevel,
  SENSITIVITY_LABEL,
  type Sensitivity,
  familyMeta,
  providerLabel,
  qualifiedToolLabel,
  toolActionLabel,
} from '@/lib/tool-taxonomy';
import { clsx } from 'clsx';
import {
  AlarmClock,
  BookOpen,
  Bot,
  Building2,
  Calculator,
  CalendarDays,
  Car,
  ChevronDown,
  ClipboardList,
  FileText,
  FolderOpen,
  Gauge,
  GitBranch,
  Globe,
  Handshake,
  Inbox,
  Lock,
  Mail,
  MessageSquare,
  MessagesSquare,
  Mic,
  PlugZap,
  Rocket,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  SquareKanban,
  Table2,
  TrendingUp,
  Type,
  UserSearch,
  Users,
  Users2,
  UsersRound,
  Wallet,
  Workflow,
  Wrench,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';

/**
 * Plain serialisable shape resolved by the server page. Nothing here may be
 * derived from `@cortex/agent-tools` on the client — importing the registry
 * into a client module breaks the production build.
 */
export interface CatalogTool {
  id: string;
  family: string;
  description: string;
  /** The tool declares requiresConfirmation, or the guardrail gates it. */
  needsApproval: boolean;
  /** Plain-language why, shown only when approval is required. */
  approvalReason: string | null;
  riskLevel: RiskLevel;
  sensitivity: Sensitivity;
  blastRadius: BlastRadius;
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
  /** Teams that deny this tool — admin-only detail, empty for everyone else. */
  restrictedFor: string[];
  /** True when at least one team denies this tool. */
  restrictedSomewhere: boolean;
  /** True when one of the signed-in user's own teams denies it. */
  deniedForMe: boolean;
}

export interface CatalogTeam {
  id: string;
  name: string;
  memberCount: number;
}

const FAMILY_ICONS: Record<string, typeof Wrench> = {
  AlarmClock,
  BookOpen,
  Building2,
  Calculator,
  CalendarDays,
  Car,
  ClipboardList,
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
  Rocket,
  ShieldCheck,
  Sparkles,
  SquareKanban,
  Table2,
  TrendingUp,
  Type,
  Users,
  UserSearch,
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
  low: 'bg-surface-2 text-ink-muted',
  medium: 'bg-sky-soft text-sky',
  high: 'bg-amber-soft text-amber',
  critical: 'bg-rose-soft text-rose',
};

type RiskFilter = 'all' | RiskLevel;
type ConnectionFilter = 'all' | 'needs-connection' | 'no-integration';

/** Small on/off switch used for both family and tool rows. */
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
          'absolute left-0.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-surface shadow-card transition-transform',
          on && 'translate-x-4',
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
        'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-[11.5px] font-semibold transition-colors',
        active
          ? 'bg-primary text-white'
          : 'bg-surface-2 text-ink-muted hover:bg-primary-soft hover:text-primary',
      )}
    >
      {children}
    </button>
  );
}

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
        'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[10.5px] font-semibold',
        className,
      )}
    >
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  );
}

export function ToolsCatalog({
  tools,
  isAdmin,
  teams,
  selectedTeamId,
  initialTeamDenied,
}: {
  tools: CatalogTool[];
  isAdmin: boolean;
  teams: CatalogTeam[];
  selectedTeamId: string;
  /** Patterns the selected team denies (allowed = false rows). */
  initialTeamDenied: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const [approvalOnly, setApprovalOnly] = useState(false);
  const [restrictedOnly, setRestrictedOnly] = useState(false);
  const [risk, setRisk] = useState<RiskFilter>('all');
  const [connection, setConnection] = useState<ConnectionFilter>('all');
  const [openFamilies, setOpenFamilies] = useState<Set<string>>(new Set());
  const [denied, setDenied] = useState<string[]>(initialTeamDenied);
  const [savingPattern, setSavingPattern] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-sync whenever the server sends permissions for a (possibly different)
  // selected team.
  useEffect(() => {
    setDenied(initialTeamDenied);
  }, [initialTeamDenied]);

  const filtersActive =
    query.trim() !== '' || approvalOnly || restrictedOnly || risk !== 'all' || connection !== 'all';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tools.filter((t) => {
      if (approvalOnly && !t.needsApproval) return false;
      if (restrictedOnly && !t.restrictedSomewhere) return false;
      if (risk !== 'all' && t.riskLevel !== risk) return false;
      if (connection === 'needs-connection' && t.missingProviders.length === 0) return false;
      if (connection === 'no-integration' && t.providers.length > 0) return false;
      if (!q) return true;
      const meta = familyMeta(t.family);
      return (
        t.id.toLowerCase().includes(q) ||
        toolActionLabel(t.id).toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q) ||
        meta.name.toLowerCase().includes(q) ||
        meta.blurb.toLowerCase().includes(q) ||
        t.family.includes(q)
      );
    });
  }, [tools, query, approvalOnly, restrictedOnly, risk, connection]);

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogTool[]>();
    for (const t of filtered) {
      const list = map.get(t.family);
      if (list) list.push(t);
      else map.set(t.family, [t]);
    }
    return [...map.entries()].sort(([a], [b]) =>
      familyMeta(a).name.localeCompare(familyMeta(b).name),
    );
  }, [filtered]);

  const selectedTeam = isAdmin ? (teams.find((t) => t.id === selectedTeamId) ?? null) : null;
  const deniedSet = useMemo(() => new Set(denied), [denied]);
  const allOpen = grouped.length > 0 && grouped.every(([f]) => openFamilies.has(f));

  // A search or filter is a request to see what matched — collapsed sections
  // would hide exactly the thing the user just asked for.
  const isOpen = (family: string) => filtersActive || openFamilies.has(family);

  function toggleFamily(family: string) {
    setOpenFamilies((prev) => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  }

  function selectTeam(id: string) {
    setError(null);
    startTransition(() => {
      router.replace(id ? `/tools?team=${encodeURIComponent(id)}` : '/tools', {
        scroll: false,
      });
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
        body: JSON.stringify({
          teamId: selectedTeam.id,
          toolPattern: pattern,
          allowed,
        }),
      });
      if (!res.ok) throw new Error('save failed');
    } catch {
      setDenied(prev);
      setError('Could not save the change. Please try again.');
    } finally {
      setSavingPattern(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {isAdmin && (
        <Panel className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-primary-soft text-primary">
              <UsersRound className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ink">Team access</div>
              <div className="text-[11.5px] text-ink-faint">
                Access is granted per team, never per person. Pick a team to block whole families or
                individual tools for everyone in it.
              </div>
            </div>
            <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
              <select
                value={selectedTeamId}
                onChange={(e) => selectTeam(e.target.value)}
                aria-label="Team to edit permissions for"
                className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 sm:w-auto sm:min-w-[240px]"
              >
                <option value="">— browse only (no team selected) —</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {selectedTeam && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-ink-muted">
                  <Users2 className="h-3 w-3" />
                  {selectedTeam.memberCount} member
                  {selectedTeam.memberCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
          {selectedTeam && (
            <p className="mt-2 text-[11.5px] text-ink-faint">
              Toggles control what{' '}
              <span className="font-semibold text-ink-muted">{selectedTeam.name}</span> can use. Off
              blocks the tool for every member of the team; on removes the block and restores the
              agent default. Teams only ever subtract — a second team cannot restore what this one
              denies.
              {isPending && <span className="ml-2 text-primary">Loading permissions…</span>}
            </p>
          )}
          {teams.length === 0 && (
            <p className="mt-2 text-[11.5px] text-ink-faint">
              No teams yet — create one in Admin → Teams first.
            </p>
          )}
          {error && <p className="mt-2 text-[11.5px] font-semibold text-rose">{error}</p>}
        </Panel>
      )}

      <Panel className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative flex min-w-[240px] flex-1 items-center">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-ink-faint" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name, what it does, or the system it touches…"
              className="h-9 w-full rounded-pill border border-border bg-surface-2 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:bg-surface focus:outline-none focus:ring-4 focus:ring-primary/10"
            />
          </label>
          <button
            type="button"
            onClick={() => setOpenFamilies(allOpen ? new Set() : new Set(grouped.map(([f]) => f)))}
            disabled={filtersActive}
            className="rounded-pill border border-border bg-surface px-3 py-1.5 text-[11.5px] font-semibold text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            {allOpen ? 'Collapse all' : 'Expand all'}
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
            Filter
          </span>
          <FilterChip active={approvalOnly} onClick={() => setApprovalOnly((v) => !v)}>
            <ShieldAlert className="h-3 w-3" />
            Needs approval
          </FilterChip>
          <FilterChip active={restrictedOnly} onClick={() => setRestrictedOnly((v) => !v)}>
            <Lock className="h-3 w-3" />
            Restricted for a team
          </FilterChip>
          <FilterChip
            active={connection === 'needs-connection'}
            onClick={() =>
              setConnection((v) => (v === 'needs-connection' ? 'all' : 'needs-connection'))
            }
          >
            <PlugZap className="h-3 w-3" />
            Integration not connected
          </FilterChip>
          <FilterChip
            active={connection === 'no-integration'}
            onClick={() =>
              setConnection((v) => (v === 'no-integration' ? 'all' : 'no-integration'))
            }
          >
            <Sparkles className="h-3 w-3" />
            Works with no integration
          </FilterChip>

          <span className="mx-1 h-4 w-px bg-border" />
          <span className="mr-1 text-[10.5px] font-semibold uppercase tracking-[0.1em] text-ink-faint">
            Risk
          </span>
          {(['all', 'low', 'medium', 'high', 'critical'] as RiskFilter[]).map((level) => (
            <FilterChip key={level} active={risk === level} onClick={() => setRisk(level)}>
              {level === 'all' ? 'Any' : RISK_LABEL[level].replace(' risk', '')}
            </FilterChip>
          ))}
        </div>

        <p className="text-[11px] leading-relaxed text-ink-faint">
          Risk is the baseline the guardrail assigns to a tool from what it touches and how far it
          reaches. The real call can be scored higher — compensation figures in the payload, a
          recipient outside the company, or a bulk export all raise it, and only the genuinely
          dangerous combinations are refused outright. Everything else runs and is recorded.
        </p>
      </Panel>

      {grouped.length === 0 ? (
        <Panel className="p-10 text-center text-[13px] text-ink-faint">
          No tools match your search.
        </Panel>
      ) : (
        <div className="flex flex-col gap-3">
          {grouped.map(([family, list]) => {
            const meta = familyMeta(family);
            const Icon = FAMILY_ICONS[meta.icon] ?? Wrench;
            const familyPattern = `${family}.*`;
            const familyBlocked = deniedSet.has(familyPattern);
            const open = isOpen(family);
            const approvals = list.filter((t) => t.needsApproval).length;
            const restricted = list.filter((t) => t.restrictedSomewhere).length;

            return (
              <Panel key={family} className="overflow-hidden">
                <div className="flex items-start gap-3 p-4">
                  <button
                    type="button"
                    onClick={() => toggleFamily(family)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-start gap-3 text-left"
                  >
                    <span
                      className={clsx(
                        'grid h-9 w-9 shrink-0 place-items-center rounded-[10px]',
                        TONE_CHIP[meta.tone],
                      )}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[14px] font-bold text-ink">{meta.name}</span>
                        <span className="font-mono text-[10.5px] text-ink-faint">
                          {familyPattern}
                        </span>
                        <span className="text-[10.5px] text-ink-faint">
                          {list.length} tool{list.length === 1 ? '' : 's'}
                        </span>
                        {approvals > 0 && (
                          <span className="text-[10.5px] font-semibold text-amber">
                            {approvals} need approval
                          </span>
                        )}
                        {restricted > 0 && (
                          <span className="text-[10.5px] font-semibold text-rose">
                            {restricted} restricted
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block text-[12px] leading-snug text-ink-muted">
                        {meta.blurb}
                      </span>
                    </span>
                    <ChevronDown
                      className={clsx(
                        'mt-1 h-4 w-4 shrink-0 text-ink-faint transition-transform',
                        open && 'rotate-180',
                      )}
                    />
                  </button>
                  {selectedTeam && (
                    <div className="flex shrink-0 flex-col items-end gap-1 pt-1">
                      <Toggle
                        on={!familyBlocked}
                        disabled={savingPattern === familyPattern}
                        label={`${familyBlocked ? 'Allow' : 'Block'} the whole ${meta.name} family for ${selectedTeam.name}`}
                        onClick={() => setPermission(familyPattern, familyBlocked)}
                      />
                      <span
                        className={clsx(
                          'text-[9.5px] font-semibold uppercase tracking-[0.08em]',
                          familyBlocked ? 'text-rose' : 'text-ink-faint',
                        )}
                      >
                        {familyBlocked ? 'Family blocked' : 'Whole family'}
                      </span>
                    </div>
                  )}
                </div>

                {open && (
                  <div className="border-t border-border">
                    {list.map((t, i) => {
                      const toolBlocked = deniedSet.has(t.id);
                      const blocked = toolBlocked || familyBlocked;
                      const unavailable = selectedTeam ? blocked : t.deniedForMe;
                      return (
                        <div
                          key={t.id}
                          className={clsx(
                            'flex items-start gap-4 px-4 py-3',
                            i > 0 && 'border-t border-border',
                          )}
                        >
                          <div className={clsx('min-w-0 flex-1', unavailable && 'opacity-60')}>
                            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                              <span
                                className="text-[13.5px] font-semibold text-ink"
                                title={qualifiedToolLabel(t.id)}
                              >
                                {toolActionLabel(t.id)}
                              </span>
                              {/* Raw id kept as secondary detail: it is what the
                                  permission patterns and audit log speak. */}
                              <code className="font-mono text-[11px] text-ink-faint">{t.id}</code>
                            </div>
                            <p className="mt-0.5 text-[12.5px] leading-snug text-ink-muted">
                              {t.description}
                            </p>

                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              <Badge
                                className={RISK_CHIP[t.riskLevel]}
                                title={[
                                  `${SENSITIVITY_LABEL[t.sensitivity]} · ${BLAST_LABEL[t.blastRadius]}`,
                                  t.outboundRiskLevel
                                    ? `Rises to ${RISK_LABEL[t.outboundRiskLevel].toLowerCase()} when addressed outside the company`
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(' — ')}
                              >
                                {RISK_LABEL[t.riskLevel]}
                                {t.outboundRiskLevel ? ' +' : ''}
                              </Badge>
                              <Badge className="bg-surface-2 text-ink-muted">
                                {SENSITIVITY_LABEL[t.sensitivity]}
                              </Badge>
                              {t.canLeaveCompany ? (
                                <Badge
                                  className="bg-rose-soft text-rose"
                                  icon={Send}
                                  title={
                                    t.outboundRiskLevel
                                      ? `Scored ${RISK_LABEL[t.outboundRiskLevel].toLowerCase()} once it is addressed to someone outside the company`
                                      : 'Content reaches people outside the company'
                                  }
                                >
                                  Can leave the company
                                </Badge>
                              ) : (
                                <Badge className="bg-surface-2 text-ink-muted">
                                  {BLAST_LABEL[t.blastRadius]}
                                </Badge>
                              )}
                              {t.needsApproval ? (
                                <Badge className="bg-amber-soft text-amber" icon={ShieldAlert}>
                                  Needs approval
                                </Badge>
                              ) : (
                                <Badge className="bg-emerald-soft text-emerald">
                                  Runs without approval
                                </Badge>
                              )}
                              {t.providers.map((p) => {
                                const missing = t.missingProviders.includes(p);
                                return (
                                  <Badge
                                    key={p}
                                    icon={PlugZap}
                                    className={
                                      missing
                                        ? 'bg-rose-soft text-rose'
                                        : 'bg-emerald-soft text-emerald'
                                    }
                                    title={
                                      missing
                                        ? `${providerLabel(p)} is not connected on your account — connect it in Integrations`
                                        : `${providerLabel(p)} is connected`
                                    }
                                  >
                                    {providerLabel(p)}
                                    {missing ? ' not connected' : ''}
                                  </Badge>
                                );
                              })}
                              {t.ratePerMinute != null && (
                                <Badge
                                  className="bg-surface-2 font-mono text-ink-faint"
                                  icon={Gauge}
                                  title="Rate limit per user, per minute"
                                >
                                  {t.ratePerMinute}/min
                                </Badge>
                              )}
                              {t.agents.map((name) => (
                                <Badge
                                  key={name}
                                  className="bg-primary-soft text-primary"
                                  icon={Bot}
                                  title={`Exposed by the ${name} agent`}
                                >
                                  {name}
                                </Badge>
                              ))}
                              {t.restrictedFor.length > 0 ? (
                                <Badge
                                  className="bg-rose-soft text-rose"
                                  icon={Lock}
                                  title={`Blocked for ${t.restrictedFor.join(', ')}`}
                                >
                                  Blocked for {t.restrictedFor.join(', ')}
                                </Badge>
                              ) : (
                                isAdmin && (
                                  <Badge className="bg-surface-2 text-ink-muted" icon={Users2}>
                                    All teams
                                  </Badge>
                                )
                              )}
                              {!isAdmin && t.deniedForMe && (
                                <Badge className="bg-rose-soft text-rose" icon={Lock}>
                                  Not available to your team
                                </Badge>
                              )}
                            </div>

                            {t.needsApproval && t.approvalReason && (
                              <p className="mt-1.5 border-l-2 border-amber/40 pl-2 text-[11.5px] leading-snug text-ink-faint">
                                {t.approvalReason}
                              </p>
                            )}
                          </div>

                          {selectedTeam && (
                            <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
                              <Toggle
                                on={!blocked}
                                disabled={familyBlocked || savingPattern === t.id}
                                label={`${blocked ? 'Allow' : 'Block'} ${qualifiedToolLabel(t.id)} for ${selectedTeam.name}`}
                                onClick={() => setPermission(t.id, toolBlocked)}
                              />
                              {familyBlocked ? (
                                <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-rose">
                                  By family
                                </span>
                              ) : (
                                toolBlocked && (
                                  <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-rose">
                                    Blocked
                                  </span>
                                )
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </Panel>
            );
          })}
        </div>
      )}
    </div>
  );
}
