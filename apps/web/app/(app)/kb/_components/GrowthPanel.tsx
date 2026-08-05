'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { LOBE_NAME } from './field/field-math';
import { num, weekLabel } from './format';
import type { BrainStats, IntakeKey } from './types';

/**
 * What it has taken in, week by week.
 *
 * Documents rather than fragments, for two reasons: a document is what a person
 * remembers handing over, and the count is one this page already holds — no
 * figure in this chart is derived from another chart.
 *
 * WHAT USED TO LIVE IN THIS FILE. The anatomical plate — a fixed four-lobe
 * drawing whose ink levels were document counts. It has been replaced by the
 * relief map in `field/`, which draws the same anatomy from the corpus instead
 * of from constants and is the navigation rather than an illustration beside
 * it. The lobe names moved to `field-math.ts` so both readings of the anatomy
 * come from one place.
 */
export function GrowthPanel({ stats, focus }: { stats: BrainStats; focus?: IntakeKey | null }) {
  const peak = Math.max(...stats.growth.map((w) => w.added), 1);
  const anything = stats.growth.some((w) => w.added > 0);
  const quarter = stats.growth.reduce((sum, w) => sum + w.added, 0);
  const first = stats.growth[0];
  const last = stats.growth[stats.growth.length - 1];

  return (
    <Panel>
      <PanelHead
        title="Lo que ha aprendido"
        right={focus ? `solo ${LOBE_NAME[focus].toLowerCase()}` : 'últimas 12 semanas'}
      />
      <p className="px-5 pt-1 text-[12.5px] text-ink-muted">
        {anything
          ? `${num(quarter)} documentos entraron en este trimestre.`
          : focus
            ? `No ha entrado nada de ${LOBE_NAME[focus].toLowerCase()} en las últimas 12 semanas.`
            : 'No ha entrado nada en las últimas 12 semanas.'}
      </p>

      <div className="border-t border-border px-5 pb-4 pt-4">
        <div className="flex items-end gap-1" style={{ height: 96 }}>
          {stats.growth.map((week) => {
            const h = week.added === 0 ? 2 : Math.max(4, (week.added / peak) * 96);
            return (
              <div
                key={week.start}
                className="group relative flex-1"
                style={{ height: `${h}px` }}
                title={`${weekLabel(week.start)}: ${num(week.added)}`}
              >
                <div
                  className={clsx(
                    'h-full w-full rounded-t-[2px] transition-[height] duration-700',
                    week.added === 0 ? 'bg-border' : 'bg-primary',
                  )}
                />
              </div>
            );
          })}
        </div>

        {/* Ruled baseline, then the ends of the axis labelled directly — a
            legend would only repeat what two dates already say. */}
        <div className="mt-1 border-t border-border-strong pt-1.5">
          <div className="flex items-center justify-between text-[10.5px] text-ink-faint">
            <span className="tabular">{first ? weekLabel(first.start) : ''}</span>
            <span>
              máximo <span className="stat-num text-ink-muted">{num(peak)}</span> por semana
            </span>
            <span className="tabular">{last ? `${weekLabel(last.start)} (esta)` : ''}</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
