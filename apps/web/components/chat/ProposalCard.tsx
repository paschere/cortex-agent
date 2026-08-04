'use client';

import { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Building2,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Sparkles,
} from 'lucide-react';

/**
 * Structured render of a `sales.draft_proposal` (a.k.a. `sales_draft_proposal`)
 * tool result. The composite tool returns a JSON payload plus a pre-rendered
 * Markdown string; this component renders the structured fields and uses the
 * Markdown for the "Copy as Markdown" action.
 *
 * The shape is intentionally permissive: it renders whatever the tool provides
 * today (company, roles with monthly ranges, recent activity, similar KB cases,
 * markdown) and surfaces the richer fields the T2.2 composite hardening adds
 * later (hourly ranges, deal stage/amount, timeline, "Why us" bullets)
 * when they are present.
 */

export interface ProposalRole {
  role: string;
  seniority: string;
  qty: number;
  techStack?: string[];
  monthlyRange?: { min: number; max: number } | null;
  /** Hourly range — present once T2.2 composite hardening ships. */
  hourlyRange?: { min: number; max: number } | null;
  confidence?: number;
}

export interface ProposalActivity {
  id: string;
  type: string;
  subject: string | null;
  createdAt: string;
}

export interface ProposalSimilarCase {
  title: string;
  chunkIndex: number;
  excerpt: string;
}

export interface ProposalDeal {
  stage?: string | null;
  amount?: number | null;
  /** Optional explicit days-since-last-activity; otherwise derived from recentActivity. */
  daysSinceLastActivity?: number | null;
}

export interface ProposalResult {
  company: {
    id: string;
    name: string | null;
    industry: string | null;
    country: string | null;
  };
  roles: ProposalRole[];
  recentActivity?: ProposalActivity[];
  similarCases?: ProposalSimilarCase[];
  /** Optional deal context block — present once T2.2 composite hardening ships. */
  deal?: ProposalDeal | null;
  /** Optional "Why us" bullets sourced from KB hits. */
  whyUs?: string[];
  /** Optional timeline / next-steps lines. */
  timeline?: string[];
  /** Pre-rendered Markdown for the copy action. */
  markdown?: string;
}

const HOURS_PER_MONTH = 160;

function formatUsd(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatRange(range?: { min: number; max: number } | null): string {
  if (!range) return '—';
  if (range.min === range.max) return `$${formatUsd(range.min)}`;
  return `$${formatUsd(range.min)}–$${formatUsd(range.max)}`;
}

/** Derive an hourly range from a monthly range when the tool did not provide one. */
function hourlyFromMonthly(
  monthly?: { min: number; max: number } | null,
): { min: number; max: number } | null {
  if (!monthly) return null;
  return {
    min: Math.round(monthly.min / HOURS_PER_MONTH),
    max: Math.round(monthly.max / HOURS_PER_MONTH),
  };
}

/** Most recent activity date → whole days elapsed. */
function daysSince(dateIso: string): number | null {
  const then = new Date(dateIso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / 86_400_000);
}

function activityPill(days: number): { label: string; className: string } {
  if (days < 14) {
    return {
      label: `${days}d since last activity`,
      className: 'bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300',
    };
  }
  if (days <= 30) {
    return {
      label: `${days}d since last activity`,
      className: 'bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
    };
  }
  return {
    label: `${days}d since last activity`,
    className: 'bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300',
  };
}

/** Build a Markdown fallback if the tool did not supply one. */
function buildMarkdown(p: ProposalResult): string {
  const lines: string[] = [];
  lines.push(`# Proposal — ${p.company.name ?? 'Unknown'}`);
  const meta = [p.company.industry, p.company.country].filter(Boolean).join(' · ');
  if (meta) lines.push(`*${meta}*`);
  lines.push('');
  lines.push('## Roles');
  lines.push('| Role | Seniority | Qty | Monthly (USD) | Hourly (USD) | Stack |');
  lines.push('|---|---|---:|---:|---:|---|');
  for (const r of p.roles) {
    const hourly = r.hourlyRange ?? hourlyFromMonthly(r.monthlyRange);
    lines.push(
      `| ${r.role} | ${r.seniority} | ${r.qty} | ${formatRange(r.monthlyRange)} | ${formatRange(hourly)} | ${(r.techStack ?? []).join(', ')} |`,
    );
  }
  return lines.join('\n');
}

type SortKey = 'role' | 'seniority' | 'qty' | 'monthly' | 'hourly';
type SortDir = 'asc' | 'desc';

export function ProposalCard({ result }: { result: ProposalResult }) {
  const [copied, setCopied] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);

  const rawRoles = result.roles ?? [];

  const roles = useMemo(() => {
    if (!sort) return rawRoles;
    const dir = sort.dir === 'asc' ? 1 : -1;
    const monthlyMid = (r: ProposalRole) =>
      r.monthlyRange ? (r.monthlyRange.min + r.monthlyRange.max) / 2 : 0;
    const hourlyMid = (r: ProposalRole) => {
      const h = r.hourlyRange ?? hourlyFromMonthly(r.monthlyRange);
      return h ? (h.min + h.max) / 2 : 0;
    };
    return [...rawRoles].sort((a, b) => {
      switch (sort.key) {
        case 'role':
          return dir * a.role.localeCompare(b.role);
        case 'seniority':
          return dir * a.seniority.localeCompare(b.seniority);
        case 'qty':
          return dir * (a.qty - b.qty);
        case 'monthly':
          return dir * (monthlyMid(a) - monthlyMid(b));
        case 'hourly':
          return dir * (hourlyMid(a) - hourlyMid(b));
        default:
          return 0;
      }
    });
  }, [rawRoles, sort]);

  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );

  // Derive "Why us" bullets from explicit field or KB similar cases.
  const whyBullets = useMemo(() => {
    if (result.whyUs?.length) return result.whyUs;
    return (result.similarCases ?? []).map(
      (c) => `${c.title}: ${c.excerpt.replace(/\s+/g, ' ').trim()}`,
    );
  }, [result.whyUs, result.similarCases]);

  // Days since last activity: explicit on deal, else from most recent activity.
  const daysLast = useMemo(() => {
    if (typeof result.deal?.daysSinceLastActivity === 'number') {
      return result.deal.daysSinceLastActivity;
    }
    const activities = result.recentActivity ?? [];
    if (!activities.length) return null;
    const latest = activities
      .map((a) => a.createdAt)
      .filter(Boolean)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];
    return latest ? daysSince(latest) : null;
  }, [result.deal, result.recentActivity]);

  // Monthly totals across the table (qty-weighted).
  const totals = useMemo(() => {
    let min = 0;
    let max = 0;
    let any = false;
    for (const r of roles) {
      if (r.monthlyRange) {
        any = true;
        min += r.monthlyRange.min * r.qty;
        max += r.monthlyRange.max * r.qty;
      }
    }
    return any ? { min, max } : null;
  }, [roles]);

  const onCopy = async () => {
    const md = result.markdown ?? buildMarkdown(result);
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); fail silently.
    }
  };

  // The pill is derivable from recentActivity today; stage/amount arrive with
  // the T2.2 composite hardening. Show the banner whenever any of them exist.
  const hasDealContext =
    daysLast != null ||
    (!!result.deal && (result.deal.stage != null || result.deal.amount != null));

  return (
    <div className="not-prose w-full max-w-2xl overflow-hidden rounded-xl border border-neutral-200 bg-white text-neutral-900 shadow-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-4 py-3 dark:border-neutral-700">
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5 rounded-lg bg-neutral-100 p-1.5 dark:bg-neutral-800">
            <Building2 className="h-4 w-4 text-neutral-500" />
          </div>
          <div>
            <h3 className="text-sm font-semibold leading-tight">
              {result.company.name ?? 'Untitled company'}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {result.company.industry && (
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                  {result.company.industry}
                </span>
              )}
              {result.company.country && (
                <span className="text-[11px] text-neutral-500">{result.company.country}</span>
              )}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 transition-colors hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          aria-label="Copy proposal as Markdown"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-green-600" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? 'Copied' : 'Copy as Markdown'}
        </button>
      </div>

      {/* Deal context banner */}
      {hasDealContext && (
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-xs dark:border-neutral-700 dark:bg-neutral-800/50">
          {result.deal?.stage && (
            <span className="font-medium text-neutral-700 dark:text-neutral-200">
              Stage: {result.deal.stage}
            </span>
          )}
          {result.deal?.amount != null && (
            <span className="text-neutral-600 dark:text-neutral-300">
              · ${formatUsd(result.deal.amount)}
            </span>
          )}
          {daysLast != null && (
            <span
              className={`ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${activityPill(daysLast).className}`}
            >
              <Clock className="h-3 w-3" />
              {activityPill(daysLast).label}
            </span>
          )}
        </div>
      )}

      {/* Rate table */}
      <div className="px-4 py-3">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-[11px] uppercase tracking-wide text-neutral-400 dark:border-neutral-700">
                {(
                  [
                    { key: 'role', label: 'Role', align: 'left' },
                    { key: 'seniority', label: 'Seniority', align: 'left' },
                    { key: 'qty', label: 'Qty', align: 'right' },
                    { key: 'monthly', label: 'Monthly', align: 'right' },
                    { key: 'hourly', label: 'Hourly', align: 'right' },
                  ] as Array<{
                    key: SortKey;
                    label: string;
                    align: 'left' | 'right';
                  }>
                ).map((col) => {
                  const active = sort?.key === col.key;
                  return (
                    <th
                      key={col.key}
                      className={`py-1.5 pr-3 font-medium ${col.align === 'right' ? 'text-right' : ''}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className={`inline-flex items-center gap-1 uppercase tracking-wide transition-colors hover:text-neutral-700 dark:hover:text-neutral-200 ${active ? 'text-neutral-700 dark:text-neutral-200' : ''} ${col.align === 'right' ? 'flex-row-reverse' : ''}`}
                        aria-label={`Sort by ${col.label}`}
                      >
                        {col.label}
                        {active &&
                          (sort?.dir === 'asc' ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : (
                            <ArrowDown className="h-3 w-3" />
                          ))}
                      </button>
                    </th>
                  );
                })}
                <th className="py-1.5 font-medium">Stack</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r, i) => {
                const hourly = r.hourlyRange ?? hourlyFromMonthly(r.monthlyRange);
                return (
                  <tr
                    key={`${r.role}-${r.seniority}-${i}`}
                    className="border-b border-neutral-100 last:border-0 dark:border-neutral-800"
                  >
                    <td className="py-2 pr-3 font-medium capitalize">{r.role}</td>
                    <td className="py-2 pr-3 capitalize text-neutral-600 dark:text-neutral-300">
                      {r.seniority}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{r.qty}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      {formatRange(r.monthlyRange)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-neutral-600 dark:text-neutral-300">
                      {formatRange(hourly)}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {(r.techStack ?? []).map((t) => (
                          <span
                            key={t}
                            className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {totals && (
              <tfoot>
                <tr className="border-t-2 border-neutral-200 font-semibold dark:border-neutral-700">
                  <td className="py-2 pr-3" colSpan={3}>
                    Total monthly
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatRange(totals)}</td>
                  <td className="py-2 pr-3" />
                  <td className="py-2" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Why us (collapsible) */}
      {whyBullets.length > 0 && (
        <div className="border-t border-neutral-200 px-4 py-2 dark:border-neutral-700">
          <button
            type="button"
            onClick={() => setWhyOpen((o) => !o)}
            className="flex w-full items-center gap-2 py-1 text-left text-xs font-medium"
          >
            <Sparkles className="h-3.5 w-3.5 text-neutral-400" />
            <span className="flex-1">Why us</span>
            <ChevronDown
              className={`h-3.5 w-3.5 text-neutral-400 transition-transform ${whyOpen ? 'rotate-180' : ''}`}
            />
          </button>
          {whyOpen && (
            <ul className="mt-1 list-disc space-y-1 pb-2 pl-5 text-xs text-neutral-600 dark:text-neutral-300">
              {whyBullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Timeline */}
      {result.timeline && result.timeline.length > 0 && (
        <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-700">
          <h4 className="mb-1.5 flex items-center gap-2 text-xs font-medium">
            <Clock className="h-3.5 w-3.5 text-neutral-400" />
            Timeline
          </h4>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-neutral-600 dark:text-neutral-300">
            {result.timeline.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
