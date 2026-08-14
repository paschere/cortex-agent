'use client';

import { Provenance } from '@/components/ui/provenance';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, Building2, Check, ChevronDown, Clock, Copy } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * Structured render of a `sales.draft_proposal` (a.k.a. `sales_draft_proposal`)
 * tool result. The composite tool returns a JSON payload plus a pre-rendered
 * Markdown string; this component renders the structured fields and uses the
 * Markdown for the "Copy as Markdown" action.
 *
 * It is a rate sheet, so it is built like one: an aligned table, every figure
 * in the monospaced face so a column of them can be read down, and a soft rule
 * before the total the way a ledger closes a section.
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

// Figures are read by Colombian accountants, so they are grouped the way they
// are written here (1.234), even though the currency itself is USD.
function formatUsd(n: number): string {
  return n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
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

/**
 * How stale the deal is, in the product's own status vocabulary: in force,
 * lapsing, lapsed. Colour here is meaning, not decoration.
 */
function activityTone(days: number): string {
  if (days < 14) return 'border-emerald/20 bg-emerald-soft text-emerald';
  if (days <= 30) return 'border-amber/20 bg-amber-soft text-amber';
  return 'border-rose/20 bg-rose-soft text-rose';
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

  /**
   * "Why us" either comes as free text from the tool, or is derived from
   * Brain Knowledge hits. Only the second kind has somewhere it came from, and
   * only that kind gets a provenance chip — a claim with an empty chip beside
   * it would borrow authority it has not earned.
   */
  const whyItems = useMemo<Array<{ text: string; source?: string; detail?: string }>>(() => {
    if (result.whyUs?.length) return result.whyUs.map((text) => ({ text }));
    return (result.similarCases ?? []).map((c) => ({
      text: c.excerpt.replace(/\s+/g, ' ').trim(),
      source: c.title,
      detail: `fragmento ${c.chunkIndex}`,
    }));
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

  const columns: Array<{ key: SortKey; label: string; align: 'left' | 'right' }> = [
    { key: 'role', label: 'Rol', align: 'left' },
    { key: 'seniority', label: 'Nivel', align: 'left' },
    { key: 'qty', label: 'Cant.', align: 'right' },
    { key: 'monthly', label: 'Mensual', align: 'right' },
    { key: 'hourly', label: 'Por hora', align: 'right' },
  ];

  return (
    <div className="not-prose w-full max-w-2xl overflow-hidden rounded-card border border-border bg-surface text-ink shadow-card">
      {/* Head */}
      <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-faint">
            <Building2 className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-tight">
              {result.company.name ?? 'Empresa sin nombre'}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-faint">
              {result.company.industry && (
                <span className="rounded-pill bg-surface-2 px-2 py-0.5 font-medium text-ink-muted">
                  {result.company.industry}
                </span>
              )}
              {result.company.country && <span>{result.company.country}</span>}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-ink-muted shadow-card transition-all duration-150 hover:-translate-y-px hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transform-none motion-reduce:transition-none"
          aria-label="Copiar la propuesta como Markdown"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? 'Copiado' : 'Copiar como Markdown'}
        </button>
      </div>

      {/* Deal context */}
      {hasDealContext && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-surface-2 px-4 py-2 text-xs">
          {result.deal?.stage && (
            <span>
              <span className="text-ink-faint">Etapa </span>
              <span className="font-medium text-ink">{result.deal.stage}</span>
            </span>
          )}
          {result.deal?.amount != null && (
            <span className="tabular font-medium text-ink">${formatUsd(result.deal.amount)}</span>
          )}
          {daysLast != null && (
            <span
              className={clsx(
                'ml-auto inline-flex items-center gap-1 rounded-pill border px-2.5 py-0.5 text-micro font-medium',
                activityTone(daysLast),
              )}
            >
              <Clock className="h-3 w-3" />
              <span className="tabular">{daysLast} d</span> sin actividad
            </span>
          )}
        </div>
      )}

      {/* Rate sheet */}
      <div className="px-4 py-3">
        <div className="scroll-slim overflow-x-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr className="border-b border-border text-left">
                {columns.map((col) => {
                  const active = sort?.key === col.key;
                  return (
                    <th
                      key={col.key}
                      className={clsx('py-1.5 pr-3', col.align === 'right' && 'text-right')}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className={clsx(
                          'field-label inline-flex items-center gap-1 rounded-pill transition-colors duration-150 hover:text-primary motion-reduce:transition-none',
                          active && '!text-primary',
                          col.align === 'right' && 'flex-row-reverse',
                        )}
                        aria-label={`Ordenar por ${col.label}`}
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
                <th className="field-label py-1.5">Stack</th>
              </tr>
            </thead>
            <tbody>
              {roles.map((r, i) => {
                const hourly = r.hourlyRange ?? hourlyFromMonthly(r.monthlyRange);
                return (
                  <tr
                    key={`${r.role}-${r.seniority}-${i}`}
                    className="border-b border-border last:border-0"
                  >
                    <td className="py-2 pr-3 font-medium capitalize">{r.role}</td>
                    <td className="py-2 pr-3 capitalize text-ink-muted">{r.seniority}</td>
                    <td className="tabular py-2 pr-3 text-right">{r.qty}</td>
                    <td className="tabular py-2 pr-3 text-right">{formatRange(r.monthlyRange)}</td>
                    <td className="tabular py-2 pr-3 text-right text-ink-muted">
                      {formatRange(hourly)}
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {(r.techStack ?? []).map((t) => (
                          <span
                            key={t}
                            className="rounded-pill bg-surface-2 px-2 py-0.5 text-micro text-ink-muted"
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
          </table>
        </div>

        {/* The soft rule closes the section, the way a ledger totals a page. */}
        {totals && (
          <div className="rule-double mt-1 flex items-center justify-between pt-2 text-xs font-semibold">
            <span>Total mensual</span>
            <span className="tabular">{formatRange(totals)}</span>
          </div>
        )}
      </div>

      {/* Why us */}
      {whyItems.length > 0 && (
        <div className="border-t border-border px-4 py-2">
          <button
            type="button"
            onClick={() => setWhyOpen((o) => !o)}
            aria-expanded={whyOpen}
            className="group flex w-full items-center gap-2 rounded-pill py-1 text-left text-xs font-semibold text-ink transition-colors duration-150 hover:text-primary motion-reduce:transition-none"
          >
            <span className="flex-1">Por qué nosotros</span>
            <ChevronDown
              className={clsx(
                'h-3.5 w-3.5 text-ink-faint transition-transform duration-150 group-hover:text-primary motion-reduce:transition-none',
                whyOpen && 'rotate-180',
              )}
            />
          </button>
          {whyOpen && (
            <ul className="space-y-2 pb-2 text-xs text-ink-muted">
              {whyItems.map((b, i) => (
                <li key={i} className="leading-snug">
                  {b.text}
                  {b.source && (
                    <Provenance
                      className="ml-1.5 align-middle"
                      source={b.source}
                      {...(b.detail ? { detail: b.detail } : {})}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Timeline */}
      {result.timeline && result.timeline.length > 0 && (
        <div className="border-t border-border px-4 py-3">
          <h4 className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-ink">
            <Clock className="h-3.5 w-3.5 text-ink-faint" />
            Cronograma
          </h4>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-ink-muted">
            {result.timeline.map((t, i) => (
              <li key={i}>{t}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
