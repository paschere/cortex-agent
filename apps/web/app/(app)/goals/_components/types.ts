import type { StatusTone } from '@/lib/status-chip';

/**
 * Lo que el servidor le pasa a la pantalla, ya resuelto.
 *
 * El navegador no calcula ni una cifra ni un veredicto: recibe números ya
 * formateados y estados ya decididos. Un componente de cliente que juzgara si
 * una meta se cumplió sería un segundo sitio donde se juzga, y el día que los
 * dos discrepen ganará el que se ve, no el que está guardado.
 */

export interface ActionResult {
  ok: boolean;
  note?: string;
  error?: string;
}

/** Una opción del selector, disponible o no, con su motivo. */
export interface MetricOptionView {
  key: string;
  label: string;
  blurb: string;
  unit: string;
  unitLabel: string;
  direction: 'lower_is_better' | 'higher_is_better';
  directionLabel: string;
  suggestedTarget: number;
  sourceSystem: string;
  available: boolean;
  /** En español y accionable. Sólo cuando `available` es falso. */
  reason: string | null;
}

export interface ReadingView {
  id: string;
  periodLabel: string;
  periodStart: string;
  periodEnd: string;
  display: string;
  status: 'met' | 'breached' | 'unmeasurable';
  statusLabel: string;
  statusTone: StatusTone;
  method: string;
  sampleSize: number;
  /** El objetivo contra el que se juzgó ESE período, ya redactado. */
  judgedAgainst: string;
  frozenAt: string;
}

export interface LiveView {
  periodLabel: string;
  display: string;
  status: 'met' | 'breached' | 'unmeasurable';
  statusLabel: string;
  statusTone: StatusTone;
  method: string;
  sampleSize: number;
}

export interface GoalView {
  id: string;
  label: string;
  metricKey: string;
  /** Nulo cuando la métrica ya no está en el catálogo. */
  metricLabel: string | null;
  cadenceLabel: string;
  targetLabel: string;
  createdByName: string;
  createdOn: string;
  sourceSystem: string | null;
  /** El período cerrado más reciente. Nulo hasta que cierre el primero. */
  latest: ReadingView | null;
  /** El período en curso, medido en vivo y NO guardado. */
  live: LiveView | null;
  history: ReadingView[];
}
