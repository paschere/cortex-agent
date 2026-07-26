'use client';

import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { clsx } from 'clsx';
import { Bot, Gauge, Search, UserCog } from 'lucide-react';
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

export interface CatalogUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
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

export function ToolsCatalog({
  tools,
  isAdmin,
  users,
  selectedUserId,
  initialOverrides,
}: {
  tools: CatalogTool[];
  isAdmin: boolean;
  users: CatalogUser[];
  selectedUserId: string;
  initialOverrides: Record<string, boolean>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<string>('all');
  const [overrides, setOverrides] = useState(initialOverrides);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-sync override state whenever the server sends overrides for a
  // (possibly different) selected user.
  useEffect(() => {
    setOverrides(initialOverrides);
  }, [selectedUserId, initialOverrides]);

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

  const selectedUser = isAdmin ? (users.find((u) => u.id === selectedUserId) ?? null) : null;

  function selectUser(id: string) {
    setError(null);
    startTransition(() => {
      router.replace(id ? `/tools?user=${encodeURIComponent(id)}` : '/tools', { scroll: false });
    });
  }

  async function toggleTool(toolId: string, next: boolean) {
    if (!selectedUser || savingId) return;
    const prev = overrides;
    setError(null);
    setSavingId(toolId);
    setOverrides({ ...prev, [toolId]: next });
    try {
      const res = await fetch('/api/tools/overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: selectedUser.id, toolId, enabled: next }),
      });
      if (!res.ok) throw new Error('save failed');
    } catch {
      setOverrides(prev);
      setError('Could not save the change. Please try again.');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {isAdmin && (
        <Panel className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-primary-soft text-primary">
              <UserCog className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-ink">Per-user access</div>
              <div className="text-[11.5px] text-ink-faint">
                Pick a teammate to explicitly allow or block individual tools for them.
              </div>
            </div>
            <select
              value={selectedUserId}
              onChange={(e) => selectUser(e.target.value)}
              className="ml-auto w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 sm:w-auto sm:min-w-[240px]"
            >
              <option value="">— catalog only (no user selected) —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ? `${u.name} (${u.email})` : u.email}
                </option>
              ))}
            </select>
          </div>
          {selectedUser && (
            <p className="mt-2 text-[11.5px] text-ink-faint">
              Toggles control{' '}
              <span className="font-semibold text-ink-muted">{selectedUser.name || selectedUser.email}</span>
              &rsquo;s access. Off blocks the tool for this user; on keeps the agent default and records an
              explicit allow.
              {isPending && <span className="ml-2 text-primary">Loading overrides…</span>}
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
        grouped.map(([f, list]) => (
          <section key={f}>
            <div className="mb-2 flex items-baseline gap-2 px-0.5">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
                {familyLabel(f)}
              </h2>
              <span className="font-mono text-[10.5px] text-ink-faint">{f}.*</span>
              <span className="text-[10.5px] text-ink-faint">
                {list.length} tool{list.length === 1 ? '' : 's'}
              </span>
            </div>
            <Panel className="overflow-hidden">
              {list.map((t, i) => {
                const hasOverride = t.id in overrides;
                const enabled = overrides[t.id] !== false;
                return (
                  <div
                    key={t.id}
                    className={clsx(
                      'flex items-start gap-4 px-4 py-3',
                      i > 0 && 'border-t border-border',
                    )}
                  >
                    <div className={clsx('min-w-0 flex-1', selectedUser && !enabled && 'opacity-60')}>
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                        <span className="text-[13.5px] font-semibold text-ink">{toolTitle(t.id)}</span>
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
                    {selectedUser && (
                      <div className="flex shrink-0 flex-col items-end gap-1 pt-0.5">
                        <button
                          type="button"
                          role="switch"
                          aria-checked={enabled}
                          aria-label={`${enabled ? 'Disable' : 'Enable'} ${t.id} for ${selectedUser.name || selectedUser.email}`}
                          disabled={savingId === t.id}
                          onClick={() => toggleTool(t.id, !enabled)}
                          className={clsx(
                            'relative h-5 w-9 rounded-pill border transition-colors disabled:opacity-50',
                            enabled ? 'border-emerald bg-emerald' : 'border-border bg-surface-2',
                          )}
                        >
                          <span
                            className={clsx(
                              'absolute left-0.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-surface shadow-card transition-transform',
                              enabled && 'translate-x-4',
                            )}
                          />
                        </button>
                        {hasOverride && (
                          <span
                            className={clsx(
                              'text-[10px] font-semibold uppercase tracking-[0.08em]',
                              enabled ? 'text-emerald' : 'text-rose',
                            )}
                          >
                            {enabled ? 'Explicitly allowed' : 'Blocked'}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </Panel>
          </section>
        ))
      )}
    </div>
  );
}
