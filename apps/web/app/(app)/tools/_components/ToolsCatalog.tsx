'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { Bot, Gauge, Lock, Search, Users2, UsersRound } from 'lucide-react';
import { Panel } from '@/components/ui/panel';

export interface CatalogTool {
  id: string;
  description: string;
  /** true when the tool requires human confirmation (write action). */
  write: boolean;
  ratePerMinute: number | null;
  /** Names of the agents whose allowed_tool_ids expose this tool. */
  agents: string[];
}

export interface CatalogTeam {
  id: string;
  name: string;
  memberCount: number;
}

const FAMILY_LABELS: Record<string, string> = {
  hubspot: 'HubSpot',
  recruit: 'Recruiting',
  workable: 'Workable',
  kb: 'Knowledge Base',
  gmail: 'Gmail',
  gcal: 'Google Calendar',
  gsheets: 'Google Sheets',
  gdrive: 'Google Drive',
  github: 'GitHub',
  linear: 'Linear',
  slack: 'Slack',
  rate: 'Rates',
  payroll: 'Payroll',
  web: 'Web',
  format: 'Formatting',
  people: 'People',
  growth: 'Growth Signals',
  pipeline: 'Pipelines',
  schedule: 'Schedules',
  sales: 'Sales',
  zippy: 'Zippy',
  zipdev: 'Zipdev',
};

function familyOf(id: string): string {
  return id.split('.')[0] ?? id;
}

function familyLabel(family: string): string {
  return FAMILY_LABELS[family] ?? family.charAt(0).toUpperCase() + family.slice(1);
}

/** "hubspot.search_contacts" → "Search Contacts" */
function toolTitle(id: string): string {
  const parts = id.split('.');
  const action = (parts.length > 1 ? parts.slice(1).join('_') : parts[0]) ?? id;
  return action
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Same rules as matchPattern in @zipdev/agent-tools. */
function matchesAny(toolId: string, patterns: string[]): boolean {
  return patterns.some((pat) =>
    pat.endsWith('.*') ? toolId.startsWith(pat.slice(0, -1)) : pat === toolId,
  );
}

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

export function ToolsCatalog({
  tools,
  isAdmin,
  teams,
  selectedTeamId,
  initialTeamDenied,
  myDenied,
}: {
  tools: CatalogTool[];
  isAdmin: boolean;
  teams: CatalogTeam[];
  selectedTeamId: string;
  /** Patterns the selected team denies (allowed = false rows). */
  initialTeamDenied: string[];
  /** Patterns the signed-in user's own teams deny. */
  myDenied: string[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<string>('all');
  const [denied, setDenied] = useState<string[]>(initialTeamDenied);
  const [savingPattern, setSavingPattern] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-sync whenever the server sends permissions for a (possibly different)
  // selected team.
  useEffect(() => {
    setDenied(initialTeamDenied);
  }, [selectedTeamId, initialTeamDenied]);

  const families = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tools) {
      const f = familyOf(t.id);
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tools.filter((t) => {
      if (family !== 'all' && familyOf(t.id) !== family) return false;
      if (!q) return true;
      return t.id.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
    });
  }, [tools, query, family]);

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogTool[]>();
    for (const t of filtered) {
      const f = familyOf(t.id);
      const list = map.get(f);
      if (list) list.push(t);
      else map.set(f, [t]);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const selectedTeam = isAdmin ? (teams.find((t) => t.id === selectedTeamId) ?? null) : null;
  const deniedSet = useMemo(() => new Set(denied), [denied]);

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
                Pick a team to block whole families or individual tools for everyone in it.
              </div>
            </div>
            <div className="ml-auto flex w-full items-center gap-2 sm:w-auto">
              <select
                value={selectedTeamId}
                onChange={(e) => selectTeam(e.target.value)}
                className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 sm:w-auto sm:min-w-[240px]"
              >
                <option value="">— catalog only (no team selected) —</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {selectedTeam && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-surface-2 px-2.5 py-1 text-[11px] font-semibold text-ink-muted">
                  <Users2 className="h-3 w-3" />
                  {selectedTeam.memberCount} member{selectedTeam.memberCount === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
          {selectedTeam && (
            <p className="mt-2 text-[11.5px] text-ink-faint">
              Toggles control what{' '}
              <span className="font-semibold text-ink-muted">{selectedTeam.name}</span> can use. Off
              blocks the tool for every member of the team; on removes the block and restores the
              agent default.
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

      {/* Search + family filter */}
      <div className="flex flex-col gap-2.5">
        <label className="relative flex w-full max-w-md items-center">
          <Search className="pointer-events-none absolute left-3 h-4 w-4 text-ink-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools by id or description…"
            className="h-9 w-full rounded-pill border border-border bg-surface-2 pl-9 pr-3 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary/40 focus:bg-surface focus:outline-none focus:ring-4 focus:ring-primary/10"
          />
        </label>
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
          <button
            type="button"
            onClick={() => setFamily('all')}
            className={clsx(
              'rounded-pill px-2.5 py-1 font-semibold transition-colors',
              family === 'all' ? 'bg-primary text-white' : 'bg-surface-2 text-ink-muted hover:text-ink',
            )}
          >
            All ({tools.length})
          </button>
          {families.map(([f, count]) => (
            <button
              key={f}
              type="button"
              onClick={() => setFamily(f)}
              className={clsx(
                'rounded-pill px-2.5 py-1 font-semibold transition-colors',
                family === f ? 'bg-primary text-white' : 'bg-surface-2 text-ink-muted hover:text-ink',
              )}
            >
              {familyLabel(f)} ({count})
            </button>
          ))}
        </div>
      </div>

      {grouped.length === 0 ? (
        <Panel className="p-10 text-center text-[13px] text-ink-faint">
          No tools match your search.
        </Panel>
      ) : (
        grouped.map(([f, list]) => {
          const familyPattern = `${f}.*`;
          const familyBlocked = deniedSet.has(familyPattern);
          return (
            <section key={f}>
              <div className="mb-2 flex flex-wrap items-center gap-2 px-0.5">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                  {familyLabel(f)}
                </h2>
                <span className="font-mono text-[10.5px] text-ink-faint">{familyPattern}</span>
                <span className="text-[10.5px] text-ink-faint">
                  {list.length} tool{list.length === 1 ? '' : 's'}
                </span>
                {selectedTeam && (
                  <div className="ml-auto flex items-center gap-2">
                    <span
                      className={clsx(
                        'text-[10.5px] font-semibold uppercase tracking-[0.08em]',
                        familyBlocked ? 'text-rose' : 'text-ink-faint',
                      )}
                    >
                      {familyBlocked ? 'Family blocked' : 'Whole family'}
                    </span>
                    <Toggle
                      on={!familyBlocked}
                      disabled={savingPattern === familyPattern}
                      label={`${familyBlocked ? 'Allow' : 'Block'} the ${familyLabel(f)} family for ${selectedTeam.name}`}
                      onClick={() => setPermission(familyPattern, familyBlocked)}
                    />
                  </div>
                )}
              </div>
              <Panel className="overflow-hidden">
                {list.map((t, i) => {
                  const toolBlocked = deniedSet.has(t.id);
                  const blocked = toolBlocked || familyBlocked;
                  const notForMyTeam = !selectedTeam && matchesAny(t.id, myDenied);
                  return (
                    <div
                      key={t.id}
                      className={clsx(
                        'flex items-start gap-4 px-4 py-3',
                        i > 0 && 'border-t border-border',
                      )}
                    >
                      <div
                        className={clsx(
                          'min-w-0 flex-1',
                          ((selectedTeam && blocked) || notForMyTeam) && 'opacity-60',
                        )}
                      >
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="text-[13.5px] font-semibold text-ink">
                            {toolTitle(t.id)}
                          </span>
                          <span className="font-mono text-[11px] text-ink-faint">{t.id}</span>
                        </div>
                        <p className="mt-0.5 line-clamp-2 text-[12.5px] leading-snug text-ink-muted">
                          {t.description}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {t.write ? (
                            <span className="rounded-pill bg-amber-soft px-2 py-0.5 text-[10.5px] font-semibold text-amber">
                              Write · needs confirmation
                            </span>
                          ) : (
                            <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-[10.5px] font-semibold text-ink-muted">
                              Read-only
                            </span>
                          )}
                          {t.ratePerMinute != null && (
                            <span className="inline-flex items-center gap-1 rounded-pill bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-faint">
                              <Gauge className="h-3 w-3" />
                              {t.ratePerMinute}/min
                            </span>
                          )}
                          {notForMyTeam && (
                            <span className="inline-flex items-center gap-1 rounded-pill bg-rose-soft px-2 py-0.5 text-[10.5px] font-semibold text-rose">
                              <Lock className="h-3 w-3" />
                              Not available to your team
                            </span>
                          )}
                          {t.agents.map((name) => (
                            <span
                              key={name}
                              className="inline-flex items-center gap-1 rounded-pill bg-primary-soft px-2 py-0.5 text-[10.5px] font-semibold text-primary"
                            >
                              <Bot className="h-3 w-3" />
                              {name}
                            </span>
                          ))}
                        </div>
                      </div>
                      {selectedTeam && (
                        <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
                          <Toggle
                            on={!blocked}
                            disabled={familyBlocked || savingPattern === t.id}
                            label={`${blocked ? 'Allow' : 'Block'} ${t.id} for ${selectedTeam.name}`}
                            onClick={() => setPermission(t.id, toolBlocked)}
                          />
                          {familyBlocked ? (
                            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-rose">
                              Blocked by family
                            </span>
                          ) : (
                            toolBlocked && (
                              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-rose">
                                Blocked
                              </span>
                            )
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </Panel>
            </section>
          );
        })
      )}
    </div>
  );
}
