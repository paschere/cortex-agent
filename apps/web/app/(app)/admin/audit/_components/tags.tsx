import { clsx } from 'clsx';
import type { ReactNode } from 'react';

/**
 * Shared tag vocabulary for the audit + security surfaces.
 *
 * Soft capsules that carry colour only where the colour means something. Low
 * risk and an ordinary `allowed` decision stay grey on purpose — if every row
 * is coloured, the one that was blocked stops standing out.
 *
 * Pure presentation — safe to import from both server and client components.
 */

export const STATUS_TAG: Record<string, string> = {
  ok: 'border-emerald/20 bg-emerald-soft text-emerald',
  error: 'border-rose/20 bg-rose-soft text-rose',
  confirmation_required: 'border-amber/20 bg-amber-soft text-amber',
  rate_limited: 'border-amber/20 bg-amber-soft text-amber',
};

export const RISK_TAG: Record<string, string> = {
  low: 'border-border bg-surface-2 text-ink-faint',
  medium: 'border-sky/20 bg-sky-soft text-sky',
  high: 'border-amber/20 bg-amber-soft text-amber',
  critical: 'border-rose/20 bg-rose-soft text-rose',
};

export const DECISION_TAG: Record<string, string> = {
  allowed: 'border-border bg-surface-2 text-ink-faint',
  confirmed: 'border-emerald/20 bg-emerald-soft text-emerald',
  flagged: 'border-amber/20 bg-amber-soft text-amber',
  blocked: 'border-rose/20 bg-rose-soft text-rose',
};

export const SURFACE_TAG: Record<string, string> = {
  web: 'border-border bg-surface-2 text-ink-muted',
  mcp: 'border-primary/15 bg-primary-soft text-primary',
  schedule: 'border-sky/20 bg-sky-soft text-sky',
};

export const SURFACE_SHORT: Record<string, string> = {
  web: 'web',
  mcp: 'claude',
  schedule: 'rutina',
};

/** DB values are English; the register is read in Spanish. */
export const STATUS_LABEL: Record<string, string> = {
  ok: 'ok',
  error: 'error',
  confirmation_required: 'pide confirmar',
  rate_limited: 'tope de uso',
};

export const RISK_LABEL: Record<string, string> = {
  low: 'bajo',
  medium: 'medio',
  high: 'alto',
  critical: 'crítico',
};

export const DECISION_LABEL: Record<string, string> = {
  allowed: 'permitida',
  confirmed: 'confirmada',
  flagged: 'marcada',
  blocked: 'bloqueada',
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
        'inline-block whitespace-nowrap rounded-pill border px-2.5 py-[3px] text-[10.5px] font-semibold',
        tone,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusTag({ status }: { status: string }) {
  return (
    <Tag tone={STATUS_TAG[status] ?? NEUTRAL}>
      {STATUS_LABEL[status] ?? status.replaceAll('_', ' ')}
    </Tag>
  );
}

export function SurfaceTag({ surface }: { surface: string | null }) {
  if (!surface) return <span className="tabular text-[10px] text-ink-faint">—</span>;
  return <Tag tone={SURFACE_TAG[surface] ?? NEUTRAL}>{SURFACE_SHORT[surface] ?? surface}</Tag>;
}

/** Low risk is deliberately quiet — only medium and up earn colour. */
export function RiskTag({ level }: { level: string | null }) {
  if (!level) return null;
  return <Tag tone={RISK_TAG[level] ?? NEUTRAL}>{RISK_LABEL[level] ?? level}</Tag>;
}

export function DecisionTag({ decision }: { decision: string | null }) {
  if (!decision || decision === 'allowed') return null;
  return <Tag tone={DECISION_TAG[decision] ?? NEUTRAL}>{DECISION_LABEL[decision] ?? decision}</Tag>;
}

/** Small grey chip used for risk signals. */
export function SignalChip({ children }: { children: ReactNode }) {
  return (
    <span className="tabular inline-block rounded-pill border border-border bg-surface-2 px-2.5 py-[3px] text-[10.5px] text-ink-muted">
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
