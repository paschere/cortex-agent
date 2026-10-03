import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { formatMoney } from '../ledger/forecast-shared';
import { scenarioAdjustmentsSchema } from '../ledger/plans';
import { type ForecastBundle, loadForecast } from './store';

/**
 * `forecast.pnl` — el pronóstico de resultados a 12 meses, por cliente y por
 * producto, con escenario opcional (0191). Sólo lectura.
 */

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const shortMonth = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;

export function forecastMarkdown(f: ForecastBundle): string {
  const p = f.pnl;
  const fm = (n: number) => formatMoney(n);
  const out = [
    `### Pronóstico de resultados, ${p.months.length} meses desde ${shortMonth(p.from)} (${p.method === 'estacional' ? 'con estacionalidad' : p.method === 'ritmo' ? 'al ritmo reciente' : 'sin historia'})`,
    `Ventas ${fm(p.totals.sales)} · gastos ${fm(p.totals.expenses)} · resultado ${fm(p.totals.margin)}${p.baseTotals ? ` (sin el escenario: ${fm(p.baseTotals.margin)})` : ''}.`,
    '',
    '| Mes | Ventas | Gastos | Resultado |',
    '|---|---:|---:|---:|',
    ...p.months.map(
      (m) =>
        `| ${shortMonth(m.month)} | ${fm(m.sales + m.otherIncome + m.scenarioIn)} | ${fm(m.expenses + m.scenarioOut)} | ${fm(m.margin)} |`,
    ),
    '',
    'Supuestos:',
    ...p.assumptions.map((a) => `- ${a}`),
  ];
  if (f.clients?.clients.length) {
    out.push('', 'Clientes que más pesan en lo que se espera vender:');
    for (const c of f.clients.clients.slice(0, 8))
      out.push(
        `- ${c.name}: ${fm(c.monthly)} al mes (${c.recurring ? `factura casi todos los meses, ${c.activeMonths} de los últimos 6` : 'ocasional: su promedio de 12 meses'}).`,
      );
  }
  if (f.demand?.length) {
    out.push('', 'Productos que se acaban primero al ritmo esperado:');
    for (const d of f.demand.slice(0, 8))
      out.push(
        `- ${d.name}: se esperan ${d.next[0]?.qty ?? 0} ${d.unit} el próximo mes; hay ${d.onHand}${d.monthsOfCover !== null ? ` (alcanza para ${String(d.monthsOfCover).replace('.', ',')} meses)` : ''}${d.runsOutIn ? `, se acabaría en ${shortMonth(d.runsOutIn)}` : ''}.`,
      );
  }
  if (f.payrollConfidential) out.push('La nómina va como un solo total confidencial.');
  if (f.gaps.length) out.push(`No pude leer: ${f.gaps.join(', ')}.`);
  out.push(
    'Es un pronóstico de caja, no una promesa: se recalcula con cada movimiento. Detalle en /presupuesto.',
  );
  return out.join('\n');
}

export const forecastPnlTool = registerTool({
  id: 'forecast.pnl',
  description:
    'Pronóstico de resultados (ventas, gastos por categoría y resultado) mes a mes para los próximos 12 meses, con estacionalidad cuando hay 12 meses o más de historia y si no al ritmo reciente; los gastos que se repiten como piso; qué clientes sostienen las ventas (los que facturan casi todos los meses) y, si hay inventario, la demanda esperada por producto y cuándo se acaba. Acepta un escenario como en Finanzas (scale_category, drop_counterparty, add_recurring, one_off). Explica sus supuestos. Úsala para «¿cuánto vamos a vender el año que viene?», «pronóstico de ventas», «¿qué pasa si perdemos a X?», «¿qué productos se van a acabar?». Sólo lectura; NO es la caja de 13 semanas (eso es ledger.forecast).',
  inputSchema: z.object({
    months: z.number().int().min(1).max(24).default(12),
    adjustments: scenarioAdjustmentsSchema
      .optional()
      .describe('Escenario opcional, como en ledger.forecast.'),
    includeDemand: z
      .boolean()
      .default(true)
      .describe('Incluir la demanda por producto del inventario.'),
  }),
  outputSchema: z.object({
    method: z.string(),
    totals: z.object({
      sales: z.number(),
      otherIncome: z.number(),
      expenses: z.number(),
      margin: z.number(),
    }),
    months: z.array(
      z.object({ month: z.string(), sales: z.number(), expenses: z.number(), margin: z.number() }),
    ),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 15 },
  handler: async (input, ctx) => {
    const f = await loadForecast(ctx.db, {
      today: bogotaToday(),
      viewerId: ctx.userId,
      horizon: input.months ?? 12,
      adjustments: input.adjustments ?? [],
      withDemand: input.includeDemand ?? true,
    });
    return {
      method: f.pnl.method,
      totals: f.pnl.totals,
      months: f.pnl.months.map((m) => ({
        month: m.month,
        sales: m.sales + m.otherIncome + m.scenarioIn,
        expenses: m.expenses + m.scenarioOut,
        margin: m.margin,
      })),
      markdown: forecastMarkdown(f),
    };
  },
});
