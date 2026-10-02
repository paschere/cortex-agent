import { clsx } from 'clsx';
import type { ReactNode } from 'react';

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
    <div className="flex items-center justify-between gap-3 px-6 pt-5">
      <div className="flex items-center gap-2.5 text-base font-bold text-ink">
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
    <span className={clsx('grid h-9 w-9 shrink-0 place-items-center rounded-sm', t.chip, t.icon)}>
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
      className="rounded-card border border-border bg-surface p-6 shadow-card"
      data-appearance-order={delay}
    >
      <div className="flex items-center gap-2.5">
        <IconChip tone={tone}>{icon}</IconChip>
        <span className="text-base font-bold text-ink-muted">{label}</span>
      </div>
      <div className="stat-num mt-4 text-xl leading-none text-ink xl:text-display">{value}</div>
      {sub && <div className="mt-2.5 text-sm text-ink-muted">{sub}</div>}
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
      <div className="mb-1.5 flex items-center justify-between text-sm">
        <span className="text-ink-muted">{label}</span>
        <span className="stat-num text-ink">{value.toLocaleString()}</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-surface-2">
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
  return <div className="field-label">{children}</div>;
}
