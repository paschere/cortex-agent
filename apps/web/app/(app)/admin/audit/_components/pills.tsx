import { clsx } from 'clsx';
import type { ReactNode } from 'react';

/**
 * Shared pill vocabulary for the audit + security surfaces.
 * Pure presentation — safe to import from both server and client components.
 */

export const STATUS_PILL: Record<string, string> = {
  ok: 'bg-emerald-soft text-emerald',
  error: 'bg-rose-soft text-rose',
  confirmation_required: 'bg-amber-soft text-amber',
  rate_limited: 'bg-amber-soft text-amber',
};

export const RISK_PILL: Record<string, string> = {
  low: 'bg-surface-2 text-ink-faint',
  medium: 'bg-sky-soft text-sky',
  high: 'bg-amber-soft text-amber',
  critical: 'bg-rose-soft text-rose',
};

export const DECISION_PILL: Record<string, string> = {
  allowed: 'bg-surface-2 text-ink-faint',
  confirmed: 'bg-emerald-soft text-emerald',
  flagged: 'bg-amber-soft text-amber',
  blocked: 'bg-rose-soft text-rose',
};

export const SURFACE_PILL: Record<string, string> = {
  web: 'bg-surface-2 text-ink-muted',
  mcp: 'bg-primary-soft text-primary',
  schedule: 'bg-sky-soft text-sky',
};

export const SURFACE_SHORT: Record<string, string> = {
  web: 'web',
  mcp: 'claude',
  schedule: 'scheduled',
};

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

export function Pill({
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
        'inline-block whitespace-nowrap rounded-pill px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide',
        tone,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  return (
    <Pill tone={STATUS_PILL[status] ?? 'bg-surface-2 text-ink-faint'}>
      {status.replaceAll('_', ' ')}
    </Pill>
  );
}

export function SurfacePill({ surface }: { surface: string | null }) {
  if (!surface) return <span className="text-[10px] text-ink-faint">—</span>;
  return (
    <Pill tone={SURFACE_PILL[surface] ?? 'bg-surface-2 text-ink-muted'}>
      {SURFACE_SHORT[surface] ?? surface}
    </Pill>
  );
}

/** Low risk is deliberately quiet — only medium and up earn colour. */
export function RiskPill({ level }: { level: string | null }) {
  if (!level) return null;
  return <Pill tone={RISK_PILL[level] ?? 'bg-surface-2 text-ink-faint'}>{level}</Pill>;
}

export function DecisionPill({ decision }: { decision: string | null }) {
  if (!decision || decision === 'allowed') return null;
  return <Pill tone={DECISION_PILL[decision] ?? 'bg-surface-2 text-ink-faint'}>{decision}</Pill>;
}

/** Small grey chip used for risk signals. */
export function SignalChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-pill bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-muted">
      {children}
    </span>
  );
}

/** Legend swatch + label for the inline charts. */
export function LegendDot({ color, label, value }: { color: string; label: string; value?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
      <span className={clsx('h-2 w-2 shrink-0 rounded-full', color)} />
      {label}
      {value && <span className="font-semibold text-ink">{value}</span>}
    </span>
  );
}
