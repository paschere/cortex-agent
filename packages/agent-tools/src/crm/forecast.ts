import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import { type OpportunityRow, type StageDef, effectiveProbability, isClosedStage } from './shape';
import { listOpportunities, loadStages } from './store';

/**
 * EL PRONÓSTICO PONDERADO DEL EMBUDO (migración 0193).
 *
 * Cada negocio abierto aporta valor × probabilidad al mes en que se espera
 * cerrar. Lo que ya debió cerrar y sigue abierto cae en el mes en curso y se
 * cuenta aparte (`overdue`): es plata que alguien prometió y no llegó. Lo que
 * no tiene fecha no se reparte en ningún mes (`undated`): adivinarle un mes
 * sería inventar ventas.
 *
 * Sólo se suman pesos; otras monedas se nombran en `otherCurrencies`.
 *
 * `crmWeightedForecast` es la lectura que el pronóstico de ventas o el
 * presupuesto (0191) pueden usar como «ventas en camino» sin saber nada del
 * embudo.
 */

export interface ForecastMonth {
  /** «2026-11». */
  month: string;
  weighted: number;
  total: number;
  count: number;
}

export interface CrmForecast {
  currency: 'COP';
  months: ForecastMonth[];
  /** Abiertas con cierre esperado ya pasado (contadas también en el mes en curso). */
  overdue: { weighted: number; total: number; count: number };
  /** Abiertas sin fecha de cierre (no entran en ningún mes). */
  undated: { weighted: number; total: number; count: number };
  /** Todo lo abierto, ponderado. */
  pipelineWeighted: number;
  pipelineTotal: number;
  otherCurrencies: string[];
}

function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export function weightedForecast(
  opps: ReadonlyArray<
    Pick<OpportunityRow, 'stage' | 'probability' | 'value' | 'currency' | 'expected_close'>
  >,
  stages: readonly StageDef[],
  opts: { today: string; months?: number },
): CrmForecast {
  const span = Math.max(1, Math.min(24, opts.months ?? 6));
  const first = opts.today.slice(0, 7);
  const months: ForecastMonth[] = Array.from({ length: span }, (_, i) => ({
    month: addMonths(first, i),
    weighted: 0,
    total: 0,
    count: 0,
  }));
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const out: CrmForecast = {
    currency: 'COP',
    months,
    overdue: { weighted: 0, total: 0, count: 0 },
    undated: { weighted: 0, total: 0, count: 0 },
    pipelineWeighted: 0,
    pipelineTotal: 0,
    otherCurrencies: [],
  };
  const others = new Set<string>();
  for (const o of opps) {
    if (isClosedStage(stages, o.stage)) continue;
    if (o.currency !== 'COP') {
      others.add(o.currency);
      continue;
    }
    const value = Number(o.value) || 0;
    const weighted = (value * effectiveProbability(o, stages)) / 100;
    out.pipelineWeighted += weighted;
    out.pipelineTotal += value;
    if (!o.expected_close) {
      out.undated.weighted += weighted;
      out.undated.total += value;
      out.undated.count += 1;
      continue;
    }
    let month = o.expected_close.slice(0, 7);
    if (o.expected_close < opts.today) {
      out.overdue.weighted += weighted;
      out.overdue.total += value;
      out.overdue.count += 1;
      month = first;
    }
    const bucket = byMonth.get(month);
    if (!bucket) continue;
    bucket.weighted += weighted;
    bucket.total += value;
    bucket.count += 1;
  }
  const round = (n: number) => Math.round(n);
  for (const m of months) {
    m.weighted = round(m.weighted);
    m.total = round(m.total);
  }
  out.overdue.weighted = round(out.overdue.weighted);
  out.undated.weighted = round(out.undated.weighted);
  out.pipelineWeighted = round(out.pipelineWeighted);
  out.otherCurrencies = [...others].sort();
  return out;
}

/**
 * Lo que viene del embudo, ponderado y por mes, para quien pronostica ventas.
 * `db` es el handle de la empresa.
 */
export async function crmWeightedForecast(
  db: SupabaseClient,
  opts: { months?: number; today?: string } = {},
): Promise<CrmForecast> {
  const today = opts.today ?? bogotaToday();
  const [{ stages }, opps] = await Promise.all([
    loadStages(db),
    listOpportunities(db, { includeClosed: false, limit: 2000 }),
  ]);
  return weightedForecast(opps, stages, { today, months: opts.months });
}
