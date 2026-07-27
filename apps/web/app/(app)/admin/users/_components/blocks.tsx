import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { LegendDot } from '../../audit/_components/pills';
import type { DayPoint } from '../_lib/user-activity';

/** Shared presentation bits for the user profile. Pure, no data access. */

type Tone = 'primary' | 'emerald' | 'amber' | 'sky' | 'rose' | 'neutral';

const TONE_CHIP: Record<Tone, string> = {
  primary: 'bg-primary-soft text-primary',
  emerald: 'bg-emerald-soft text-emerald',
  amber: 'bg-amber-soft text-amber',
  sky: 'bg-sky-soft text-sky',
  rose: 'bg-rose-soft text-rose',
  neutral: 'bg-surface-2 text-ink-faint',
};

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
      {children}
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="text-[12.5px] text-ink-faint">{children}</p>;
}

/** Compact KPI: tinted icon square + big number + caption. */
export function StatTile({
  label,
  value,
  sub,
  icon,
  tone = 'primary',
}: {
  label: string;
  value: string;
  sub?: string;
  icon: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="flex items-center gap-3 rounded-card border border-border bg-surface p-3.5 shadow-card">
      <span
        className={clsx('grid h-9 w-9 shrink-0 place-items-center rounded-[10px]', TONE_CHIP[tone])}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[15px] font-extrabold leading-tight text-ink" title={value}>
          {value}
        </div>
        <div className="truncate text-[10.5px] text-ink-faint" title={sub ?? label}>
          {sub ?? label}
        </div>
      </div>
    </div>
  );
}

/** Small tinted chip used for teams, integrations, denied patterns. */
export function Chip({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-[11.5px] font-semibold',
        TONE_CHIP[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * Daily activity bars — same CSS-only approach as /admin/usage: one flex child
 * per day, errors stacked in rose on top of successful calls in primary.
 */
export function DayBars({ days }: { days: DayPoint[] }) {
  const max = Math.max(1, ...days.map((d) => d.ok + d.error));
  const total = days.reduce((n, d) => n + d.ok + d.error, 0);

  if (total === 0) {
    return (
      <div className="flex h-28 items-center justify-center rounded-card bg-surface-2 text-[12.5px] text-ink-faint">
        No activity recorded in this window.
      </div>
    );
  }

  return (
    <>
      <div className="flex h-28 items-end gap-[3px]">
        {days.map((d) => {
          const dayTotal = d.ok + d.error;
          const h = Math.round((dayTotal / max) * 100);
          const errH = dayTotal > 0 ? Math.round((d.error / dayTotal) * h) : 0;
          return (
            <div
              key={d.day}
              className="flex-1"
              title={`${d.day}: ${dayTotal} event${dayTotal === 1 ? '' : 's'}${d.error > 0 ? ` (${d.error} error${d.error === 1 ? '' : 's'})` : ''}`}
            >
              <div className="flex h-28 flex-col justify-end overflow-hidden rounded-t-[4px]">
                <div className="w-full bg-rose" style={{ height: `${errH}%` }} />
                <div
                  className="w-full bg-primary"
                  style={{ height: `${Math.max(dayTotal > 0 ? 2 : 0, h - errH)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-ink-faint">
        <span>{days[0]?.day}</span>
        <span>{total.toLocaleString()} events</span>
        <span>{days[days.length - 1]?.day}</span>
      </div>
    </>
  );
}

/** Horizontal stacked bar + legend, built from plain divs. */
export function StackedBar({
  segments,
  total,
}: {
  segments: Array<{ key: string; label: string; value: number; color: string }>;
  total: number;
}) {
  const visible = segments.filter((s) => s.value > 0);
  return (
    <div>
      {total === 0 ? (
        <div className="h-3 w-full rounded-pill bg-surface-2" />
      ) : (
        <div className="flex h-3 w-full overflow-hidden rounded-pill bg-surface-2">
          {visible.map((s) => (
            <div
              key={s.key}
              className={s.color}
              style={{ width: `${(s.value / total) * 100}%` }}
              title={`${s.label}: ${s.value} (${Math.round((s.value / total) * 100)}%)`}
            />
          ))}
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((s) => (
          <LegendDot
            key={s.key}
            color={s.color}
            label={s.label}
            value={
              total === 0
                ? '0'
                : `${s.value.toLocaleString()} · ${Math.round((s.value / total) * 100)}%`
            }
          />
        ))}
      </div>
    </div>
  );
}

/** Horizontal count bar used by the "top tools" list. */
export function CountBar({ value, max, tone }: { value: number; max: number; tone: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
      <div
        className={clsx('h-full rounded-full', tone)}
        style={{ width: `${Math.max(3, Math.round((value / Math.max(1, max)) * 100))}%` }}
      />
    </div>
  );
}
