'use client';

import { BarChart } from '@/components/charts/BarChart';
import { CHART_COLOR } from '@/components/charts/colors';
import { Panel, PanelHead } from '@/components/ui/panel';
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

  return (
    <Panel>
      <PanelHead
        title="Lo que ha aprendido"
        right={focus ? `solo ${LOBE_NAME[focus].toLowerCase()}` : 'últimas 12 semanas'}
      />
      <p className="px-5 pt-1 text-xs text-ink-muted">
        {anything
          ? `${num(quarter)} documentos entraron en este trimestre.`
          : focus
            ? `No ha entrado nada de ${LOBE_NAME[focus].toLowerCase()} en las últimas 12 semanas.`
            : 'No ha entrado nada en las últimas 12 semanas.'}
      </p>

      <div className="border-t border-border px-5 pb-4 pt-4">
        <BarChart
          labels={stats.growth.map((w) => weekLabel(w.start))}
          bars={[
            {
              id: 'added',
              label: 'Documentos',
              color: CHART_COLOR.primary,
              values: stats.growth.map((w) => w.added),
              dim: stats.growth.length ? [stats.growth.length - 1] : [],
            },
          ]}
          nowIndex={stats.growth.length ? stats.growth.length - 1 : undefined}
          nowLabel="esta semana"
          formatValue={(n) => `${num(n)} doc.`}
          formatAxis={(n) => num(n)}
          height={170}
          legend={false}
          emptyNote="Nada nuevo en estas semanas"
          ariaLabel={`Documentos que entraron por semana, últimas 12 semanas: ${stats.growth.map((w) => `${weekLabel(w.start)} ${num(w.added)}`).join(', ')}`}
        />
        <p className="mt-1 text-center text-micro text-ink-faint">
          máximo <span className="stat-num text-ink-muted">{num(peak)}</span> por semana
        </p>
      </div>
    </Panel>
  );
}
