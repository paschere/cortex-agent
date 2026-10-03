import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { moneyText } from '../ledger/shape';
import { providerName } from './balance';
import { INCOME_LINE_META, pctChange } from './income';
import { pctText } from './indicators';
import { type StatementsResult, loadStatements } from './store';

/**
 * `statements.get` — los estados financieros en el chat (0191). Sólo lectura.
 * Con `refresh` le pide al programa contable el balance y el estado de
 * resultados (también es lectura del programa).
 */

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

export const monthName = (m: number) => MONTHS[(m - 1 + 12) % 12] ?? '';

const money = (n: number) => moneyText(n, 'COP');
const change = (now: number, before: number | null | undefined) => {
  const c = pctChange(now, before);
  return c === null ? '—' : `${c > 0 ? '+' : ''}${pctText(c)}`;
};

export function statementsMarkdown(
  r: StatementsResult,
  section: 'todo' | 'resultados' | 'balance' | 'indicadores' = 'todo',
): string {
  const out: string[] = [];
  const period = `enero a ${monthName(r.throughMonth)} de ${r.year}${r.income.partialMonth ? ' (el mes va en curso)' : ''}`;
  if (section === 'todo' || section === 'resultados') {
    out.push(`### Estado de resultados — ${period} (de caja)`);
    out.push(
      `| Renglón | ${monthName(r.throughMonth)} | Acumulado ${r.year} | Acumulado ${r.year - 1} | Cambio |`,
      '|---|---:|---:|---:|---:|',
    );
    for (const line of INCOME_LINE_META) {
      const label = line.subtotal ? `**${line.label}**` : line.label;
      const ytdPrev = r.income.ytdPrev?.[line.key];
      out.push(
        `| ${label} | ${money(r.income.month[line.key])} | ${money(r.income.ytd[line.key])} | ${ytdPrev === undefined ? '—' : money(ytdPrev)} | ${change(r.income.ytd[line.key], ytdPrev)} |`,
      );
    }
    out.push(
      'De dónde sale: el libro de plata, lo que de verdad entró y salió (sin causación ni depreciaciones). Costo, variables y fijos según cómo se clasifican las categorías en /estados.',
    );
    if (r.income.payrollConfidential)
      out.push('La nómina va como un solo total confidencial: el detalle lo ve quien administra.');
    const acc = r.accounting.pnl?.report;
    if (acc)
      out.push(
        `Según ${providerName(acc.provider)} (contable, ${acc.from} a ${acc.to}): ingresos ${money(acc.revenue)}, costo ${money(acc.costOfSales)}, gastos operacionales ${money(acc.operatingExpenses)}, utilidad neta ${money(acc.netIncome)}.`,
      );
  }
  if (section === 'todo' || section === 'balance') {
    const b = r.balance;
    out.push(
      b.basis === 'contable'
        ? `### Balance general al ${b.asOf} (${providerName(b.provider)})`
        : `### Balance aproximado al ${b.asOf} (sin programa contable)`,
    );
    out.push(
      `Activos ${money(b.totalAssets)}${b.currentAssets !== null ? ` (corrientes ${money(b.currentAssets)})` : ''} · Pasivos ${money(b.totalLiabilities)}${b.currentLiabilities !== null ? ` (corrientes ${money(b.currentLiabilities)})` : ''} · Patrimonio ${money(b.equity)}.`,
    );
    for (const l of b.lines.slice(0, 14))
      out.push(`- ${l.label}: ${money(l.amount)} — ${l.source}`);
    if (b.basis === 'aproximado')
      out.push(
        `No incluye: ${b.missing.slice(-5).join(' ')} Dilo así: es un balance aproximado, no el contable.`,
      );
    for (const n of b.notes) out.push(`Nota: ${n}`);
  }
  if (section === 'todo' || section === 'indicadores') {
    out.push('### Indicadores (últimos 12 meses de caja y el balance de arriba)');
    for (const i of r.indicators) {
      out.push(
        `- **${i.label}: ${i.display}** — ${i.formula}${i.inputs.length ? ` (${i.inputs.map((x) => `${x.label} ${x.display}`).join('; ')})` : ''}${i.note ? `. ${i.note}` : ''}`,
      );
    }
  }
  if (r.gaps.length) out.push(`No pude leer: ${r.gaps.join(', ')}.`);
  if (r.refresh?.errors.length) out.push(...r.refresh.errors);
  if (r.accounting.connected && !r.accounting.balance && section !== 'resultados')
    out.push(
      `Hay programa contable conectado pero no tengo copia de su balance para esta fecha: pídeme «actualiza los estados desde ${providerName(r.accounting.provider)}» (statements.get con refresh).`,
    );
  out.push('Más detalle, la clasificación de gastos y el «de dónde sale» de cada cifra: /estados.');
  return out.join('\n');
}

export const statementsGet = registerTool({
  id: 'statements.get',
  description:
    'Los estados financieros de la empresa: estado de resultados (mes, acumulado del año y contra el año anterior: ventas, costo, utilidad bruta, gastos variables y fijos, utilidad operacional/EBITDA aproximado, utilidad neta), balance general (del programa contable si está conectado; si no, un balance aproximado rotulado como tal con lo que no incluye) e indicadores (márgenes bruto/operacional/neto, razón corriente, endeudamiento, días de cartera, inventario y proveedores, ciclo de caja, punto de equilibrio). Cada cifra trae de dónde sale. Úsala para «¿cómo nos fue este año?», «estado de resultados», «balance general», «¿cuál es nuestro margen?», «punto de equilibrio», «indicadores financieros». Sólo lectura. `refresh` le pide al programa contable el balance y los resultados (Siigo, Alegra, QuickBooks).',
  inputSchema: z.object({
    year: z.number().int().min(2020).max(2100).nullish().describe('Año. Por defecto, el actual.'),
    month: z
      .number()
      .int()
      .min(1)
      .max(12)
      .nullish()
      .describe('Hasta qué mes (1–12). Por defecto, el mes actual (o diciembre de un año pasado).'),
    section: z.enum(['todo', 'resultados', 'balance', 'indicadores']).default('todo'),
    refresh: z
      .boolean()
      .default(false)
      .describe(
        'Pedir de nuevo el balance y los resultados al programa contable (tarda unos segundos).',
      ),
  }),
  outputSchema: z.object({
    year: z.number(),
    throughMonth: z.number(),
    basis: z.object({ income: z.literal('caja'), balance: z.enum(['contable', 'aproximado']) }),
    ytd: z.record(z.number()),
    ytdPrev: z.record(z.number()).nullable(),
    indicators: z.array(z.object({ key: z.string(), label: z.string(), display: z.string() })),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const r = await loadStatements(ctx.db, {
      today: bogotaToday(),
      viewerId: ctx.userId,
      year: input.year ?? undefined,
      throughMonth: input.month ?? undefined,
      refreshAccounting: input.refresh ?? false,
    });
    return {
      year: r.year,
      throughMonth: r.throughMonth,
      basis: { income: 'caja' as const, balance: r.balance.basis },
      ytd: r.income.ytd,
      ytdPrev: r.income.ytdPrev,
      indicators: r.indicators.map((i) => ({ key: i.key, label: i.label, display: i.display })),
      markdown: statementsMarkdown(r, input.section ?? 'todo'),
    };
  },
});
