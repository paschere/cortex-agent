import { clsx } from 'clsx';
import Link from 'next/link';
import { X } from 'lucide-react';
import {
  AUDIT_DECISIONS,
  AUDIT_RANGES,
  AUDIT_RISK_LEVELS,
  AUDIT_STATUSES,
  AUDIT_SURFACES,
  type AuditFilters,
  auditHref,
  RANGE_LABEL,
  SURFACE_LABEL,
} from '@/app/api/admin/_lib/audit-filters';

interface Chip {
  key: string;
  label: string;
  href: string;
  active: boolean;
  mono?: boolean;
}

function ChipGroup({ label, chips }: { label: string; chips: Chip[] }) {
  if (chips.length <= 1) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="field-label w-[62px] shrink-0">{label}</span>
      {chips.map((c) => (
        <Link
          key={c.key}
          href={c.href}
          className={clsx(
            'rounded-card border px-2.5 py-1 text-[11.5px] font-semibold transition-colors',
            c.mono && 'font-mono',
            c.active
              ? 'border-primary bg-primary text-white'
              : 'border-border bg-surface text-ink-muted hover:border-border-strong hover:text-ink',
          )}
        >
          {c.label}
        </Link>
      ))}
    </div>
  );
}

/**
 * Every audit filter as a combinable chip. Each chip is a plain link that
 * patches one dimension of the current query string, so the URL is always a
 * shareable description of what the auditor is looking at.
 */
export function FilterBar({
  filters,
  families,
  statusCounts,
  userLabel,
}: {
  filters: AuditFilters;
  families: string[];
  statusCounts: Record<string, number>;
  userLabel: string | null;
}) {
  const chip = (
    key: string,
    label: string,
    patch: Partial<AuditFilters>,
    active: boolean,
    mono = false,
  ): Chip => ({ key, label, href: auditHref(filters, patch), active, mono });

  const rangeChips = AUDIT_RANGES.map((r) =>
    chip(r, RANGE_LABEL[r], { range: r }, filters.range === r),
  );

  const statusChips = [
    chip('all', 'All', { status: 'all' }, filters.status === 'all'),
    ...AUDIT_STATUSES.map((s) =>
      chip(
        s,
        `${s.replaceAll('_', ' ')}${statusCounts[s] ? ` (${statusCounts[s]})` : ''}`,
        { status: s },
        filters.status === s,
      ),
    ),
  ];

  const surfaceChips = [
    chip('all', 'All', { surface: 'all' }, filters.surface === 'all'),
    ...AUDIT_SURFACES.map((s) =>
      chip(s, SURFACE_LABEL[s] ?? s, { surface: s }, filters.surface === s),
    ),
  ];

  const riskChips = [
    chip('all', 'All', { risk: 'all' }, filters.risk === 'all'),
    ...AUDIT_RISK_LEVELS.map((r) => chip(r, r, { risk: r }, filters.risk === r)),
  ];

  const decisionChips = [
    chip('all', 'All', { decision: 'all' }, filters.decision === 'all'),
    ...AUDIT_DECISIONS.map((d) => chip(d, d, { decision: d }, filters.decision === d)),
  ];

  const toolChips = [
    chip('all', 'All', { tool: '' }, !filters.tool),
    ...families.slice(0, 12).map((f) => chip(f, f, { tool: f }, filters.tool === f, true)),
  ];

  return (
    <div className="mb-4 space-y-2 rounded-card border border-border bg-surface p-3">
      <ChipGroup label="Range" chips={rangeChips} />
      <ChipGroup label="Status" chips={statusChips} />
      <ChipGroup label="Surface" chips={surfaceChips} />
      <ChipGroup label="Risk" chips={riskChips} />
      <ChipGroup label="Decision" chips={decisionChips} />
      <ChipGroup label="Tool" chips={toolChips} />
      {filters.user && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="field-label w-[62px] shrink-0">User</span>
          <span className="tabular rounded-card border border-primary/30 bg-primary-soft px-2.5 py-1 text-[11.5px] font-semibold text-primary-ink">
            {userLabel ?? `${filters.user.slice(0, 8)}…`}
          </span>
          <Link
            href={auditHref(filters, { user: '' })}
            aria-label="Clear the user filter"
            className="rounded-card p-1 text-ink-faint hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </div>
  );
}
