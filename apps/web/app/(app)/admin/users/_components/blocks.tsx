import { BarChart } from '@/components/charts/BarChart';
import { SegmentBar } from '@/components/charts/SegmentBar';
import { CHART_COLOR } from '@/components/charts/colors';
import { shortDay, toneOfClass } from '@/components/charts/scales';
import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { LegendDot } from '../../audit/_components/tags';
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

/** Border tuned to each tone so the chip's edge stays legible against its own soft fill. */
const TONE_BORDER: Record<Tone, string> = {
  primary: 'border-primary/30',
  emerald: 'border-emerald/30',
  amber: 'border-amber/30',
  sky: 'border-sky/30',
  rose: 'border-rose/30',
  neutral: 'border-border',
};

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="field-label">{children}</div>;
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="max-w-lg text-xs leading-relaxed text-ink-muted">{children}</p>;
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
        className={clsx('grid h-9 w-9 shrink-0 place-items-center rounded-sm', TONE_CHIP[tone])}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="stat-num truncate text-lg leading-tight text-ink" title={value}>
          {value}
        </div>
        <div className="truncate text-micro text-ink-faint" title={sub ?? label}>
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
        'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-micro font-semibold',
        TONE_CHIP[tone],
        TONE_BORDER[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * Actividad diaria: una barra por día, los errores en rosa encima de las
 * llamadas que salieron bien. Hecho con el kit de `components/charts`.
 */
export function DayBars({ days }: { days: DayPoint[] }) {
  const total = days.reduce((n, d) => n + d.ok + d.error, 0);

  if (total === 0) {
    return (
      <div className="flex h-28 items-center justify-center rounded-card border border-border bg-surface-2 px-4 text-center text-xs text-ink-muted">
        Sin actividad registrada en esta ventana.
      </div>
    );
  }

  return (
    <>
      <BarChart
        labels={days.map((d) => shortDay(d.day))}
        titles={days.map((d) => d.day)}
        bars={[
          {
            id: 'ok',
            label: 'Bien',
            color: CHART_COLOR.primary,
            values: days.map((d) => d.ok),
          },
          {
            id: 'error',
            label: 'Con error',
            color: CHART_COLOR.rose,
            values: days.map((d) => d.error),
          },
        ]}
        height={170}
        ariaLabel={`Actividad diaria, ${total.toLocaleString('es-CO')} eventos entre ${days[0]?.day} y ${days[days.length - 1]?.day}`}
      />
      <p className="tabular mt-1 text-center text-micro text-ink-faint">
        {total.toLocaleString()} eventos
      </p>
    </>
  );
}

/** Barra segmentada + leyenda con las cifras. */
export function StackedBar({
  segments,
  total,
}: {
  segments: Array<{ key: string; label: string; value: number; color: string }>;
  total: number;
}) {
  return (
    <SegmentBar
      name="Reparto"
      emptyNote="Sin datos suficientes"
      items={segments.map((s) => ({
        key: s.key,
        label: s.label,
        value: total === 0 ? 0 : s.value,
        display: s.value.toLocaleString('es-CO'),
        color: CHART_COLOR[toneOfClass(s.color)],
      }))}
    />
  );
}

/** Horizontal count bar used by the "top tools" list. */
export function CountBar({ value, max, tone }: { value: number; max: number; tone: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
      <div
        className={clsx('h-full', tone)}
        style={{ width: `${Math.max(3, Math.round((value / Math.max(1, max)) * 100))}%` }}
      />
    </div>
  );
}
