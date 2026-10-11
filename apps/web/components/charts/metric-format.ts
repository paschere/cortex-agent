import { formatMoney } from '@cortex/agent-tools/src/ledger/forecast-shared';
import type { MetricModel } from './metric-types';
import { formatCompact, formatFull } from './scales';

/** Cómo se escribe una cifra de una métrica: en el eje (corta) y en la ficha (entera). */
export function metricFormatters(m: Pick<MetricModel, 'fmt' | 'currency'>) {
  const money = m.fmt === 'money';
  const cop = m.currency.toUpperCase() === 'COP';
  return {
    axis: (n: number) => (money && cop ? formatCompact(n, { money: true }) : formatCompact(n)),
    value: (n: number) => (money ? formatMoney(n, m.currency) : formatFull(n)),
  };
}
