import { clsx } from 'clsx';
import type { ReactNode } from 'react';

/**
 * Shared tag vocabulary for the audit + security surfaces.
 *
 * These are stamps on a record, not chips in an app: squared, ruled, mono, and
 * coloured only where the colour carries meaning. Low risk and an ordinary
 * `allowed` decision stay grey on purpose — if every row is coloured, the one
 * that was blocked stops standing out.
 *
 * Pure presentation — safe to import from both server and client components.
 */

export const STATUS_TAG: Record<string, string> = {
  ok: 'border-emerald/40 bg-emerald-soft text-emerald',
  error: 'border-rose/40 bg-rose-soft text-rose',
  confirmation_required: 'border-amber/40 bg-amber-soft text-amber',
  rate_limited: 'border-amber/40 bg-amber-soft text-amber',
};

export const RISK_TAG: Record<string, string> = {
  low: 'border-border bg-surface-2 text-ink-faint',
  medium: 'border-sky/40 bg-sky-soft text-sky',
  high: 'border-amber/40 bg-amber-soft text-amber',
  critical: 'border-rose/40 bg-rose-soft text-rose',
};

export const DECISION_TAG: Record<string, string> = {
  allowed: 'border-border bg-surface-2 text-ink-faint',
  confirmed: 'border-emerald/40 bg-emerald-soft text-emerald',
  flagged: 'border-amber/40 bg-amber-soft text-amber',
  blocked: 'border-rose/40 bg-rose-soft text-rose',
};

export const SURFACE_TAG: Record<string, string> = {
  web: 'border-border bg-surface-2 text-ink-muted',
  mcp: 'border-primary/30 bg-primary-soft text-primary',
  schedule: 'border-sky/40 bg-sky-soft text-sky',
};

export const SURFACE_SHORT: Record<string, string> = {
  web: 'web',
  mcp: 'claude',
  schedule: 'scheduled',
};

const NEUTRAL = 'border-border bg-surface-2 text-ink-faint';

/** Bar/dot colours for the inline charts. */
export const RISK_BAR: Record<string, string> = {
  low: 'bg-emerald',
  medium: 'bg-sky',
  high: 'bg-amber',
  critical: 'bg-rose',
};

export const SURFACE_BAR: Record<string, string> = {
  web: 'bg-primary',
  mcp: 'bg-sky',
  schedule: 'bg-amber',
  unknown: 'bg-border-strong',
};

export function Tag({
  tone,
  children,
  title,
  className,
}: {
  tone: string;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-block whitespace-nowrap rounded-card border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]',
        tone,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusTag({ status }: { status: string }) {
  return <Tag tone={STATUS_TAG[status] ?? NEUTRAL}>{status.replaceAll('_', ' ')}</Tag>;
}

export function SurfaceTag({ surface }: { surface: string | null }) {
  if (!surface) return <span className="tabular text-[10px] text-ink-faint">—</span>;
  return <Tag tone={SURFACE_TAG[surface] ?? NEUTRAL}>{SURFACE_SHORT[surface] ?? surface}</Tag>;
}

/** Low risk is deliberately quiet — only medium and up earn colour. */
export function RiskTag({ level }: { level: string | null }) {
  if (!level) return null;
  return <Tag tone={RISK_TAG[level] ?? NEUTRAL}>{level}</Tag>;
}

export function DecisionTag({ decision }: { decision: string | null }) {
  if (!decision || decision === 'allowed') return null;
  return <Tag tone={DECISION_TAG[decision] ?? NEUTRAL}>{decision}</Tag>;
}

/** Small grey chip used for risk signals. */
export function SignalChip({ children }: { children: ReactNode }) {
  return (
    <span className="tabular inline-block rounded-card border border-border bg-surface-2 px-2 py-0.5 text-[10.5px] text-ink-muted">
      {children}
    </span>
  );
}

/** Legend swatch + label for the inline charts. A dot keeps its circle. */
export function LegendDot({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value?: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
      <span className={clsx('h-2 w-2 shrink-0 rounded-full', color)} />
      {label}
      {value && <span className="tabular font-semibold text-ink">{value}</span>}
    </span>
  );
}
