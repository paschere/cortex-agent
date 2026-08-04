import type { ReactNode } from 'react';
import { clsx } from 'clsx';

/**
 * The base surface: white, rounded, and lifted off the canvas.
 *
 * The hairline stays for definition at the edge, but what actually separates a
 * panel from its background is the shadow — depth by light rather than by
 * outline is what keeps a dense screen from reading as a spreadsheet.
 */
export function Panel({
  className,
  children,
  ...rest
}: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx('rounded-card border border-border bg-surface shadow-card', className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Header row inside a Panel: small icon + title, optional right slot. */
export function PanelHead({
  icon,
  title,
  right,
}: {
  icon?: ReactNode;
  title: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-5 pt-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-ink">
        {icon && <span className="text-ink-faint">{icon}</span>}
        {title}
      </div>
      {right && <div className="text-xs text-ink-faint">{right}</div>}
    </div>
  );
}

type Tone = 'primary' | 'emerald' | 'amber' | 'sky' | 'rose';

const TONE: Record<Tone, { chip: string; icon: string }> = {
  primary: { chip: 'bg-primary-soft', icon: 'text-primary' },
  emerald: { chip: 'bg-emerald-soft', icon: 'text-emerald' },
  amber: { chip: 'bg-amber-soft', icon: 'text-amber' },
  sky: { chip: 'bg-sky-soft', icon: 'text-sky' },
  rose: { chip: 'bg-rose-soft', icon: 'text-rose' },
};

/** Soft rounded square holding an icon, tinted by tone. */
export function IconChip({ tone = 'primary', children }: { tone?: Tone; children: ReactNode }) {
  const t = TONE[tone];
  return (
    <span className={clsx('grid h-8 w-8 place-items-center rounded-sm', t.chip, t.icon)}>
      {children}
    </span>
  );
}

/** Top-line KPI card: label + big number + sub caption + tinted icon. */
export function StatCard({
  label,
  value,
  sub,
  icon,
  tone = 'primary',
  delay = 0,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: ReactNode;
  tone?: Tone;
  delay?: number;
}) {
  return (
    <div
      className="animate-rise rounded-card border border-border bg-surface p-5 shadow-card"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between">
        <span className="text-[13px] font-medium text-ink-muted">{label}</span>
        <IconChip tone={tone}>{icon}</IconChip>
      </div>
      <div className="stat-num mt-3 text-[34px] leading-none text-ink">{value}</div>
      {sub && <div className="mt-2 text-xs text-ink-faint">{sub}</div>}
    </div>
  );
}

/** Labeled progress row used in the pipeline panel. */
export function ProgressRow({
  label,
  value,
  total,
  tone = 'primary',
}: {
  label: string;
  value: number;
  total: number;
  tone?: Tone;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const bar: Record<Tone, string> = {
    primary: 'bg-primary',
    emerald: 'bg-emerald',
    amber: 'bg-amber',
    sky: 'bg-sky',
    rose: 'bg-rose',
  };
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[13px]">
        <span className="text-ink-muted">{label}</span>
        <span className="stat-num text-ink">{value.toLocaleString()}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <div
          className={clsx('h-full rounded-full transition-[width] duration-700', bar[tone])}
          style={{ width: `${Math.max(pct, value > 0 ? 4 : 0)}%` }}
        />
      </div>
    </div>
  );
}

/** Tiny uppercase section label. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
      {children}
    </div>
  );
}
