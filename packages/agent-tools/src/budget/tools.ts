import { NotFoundError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../index';
import { formatMoney } from '../ledger/forecast-shared';
import { pctText } from '../statements/indicators';
import { monthName } from '../statements/tools';
import {
  BUDGET_STATUS_LABEL,
  type BudgetVsActual,
  LIGHT_LABEL,
  budgetCategoryLabel,
  budgetOverruns,
} from './shape';
import {
  type BudgetReport,
  activeBudget,
  createBudget,
  loadBudgetReport,
  setBudgetLines,
  toBudgetCategory,
} from './store';

/**
 * `budget.get` (lectura) y `budget.set_line` (confirmación) — 0191.
 */

export function budgetMarkdown(r: BudgetReport, opts: { month?: number | null } = {}): string {
  if (!r.budget || !r.vs)
    return 'Esta empresa no tiene presupuesto para ese año. Se crea en /presupuesto (desde lo real del año anterior ± un porcentaje, o desde cero), o pídemelo y lo armo con budget.set_line.';
  const vs: BudgetVsActual = r.vs;
  const m = opts.month ?? vs.throughMonth;
  const fm = (n: number) => formatMoney(n, r.budget?.currency ?? 'COP');
  const out = [
    `### ${r.budget.name} (${BUDGET_STATUS_LABEL[r.budget.status].toLowerCase()}) — presupuesto contra lo real`,
  ];
  if (vs.throughMonth === 0) {
    out.push('El año todavía no empieza: no hay real con qué comparar.');
  } else {
    const t = vs.totals;
    out.push(
      `Acumulado a ${monthName(vs.throughMonth)}${vs.currentFraction < 1 ? ' (el mes en curso, prorrateado por los días corridos)' : ''}: ingresos ${fm(t.income.actual)} de ${fm(t.income.budget)} presupuestados; gastos ${fm(t.expense.actual)} de ${fm(t.expense.budget)}; margen ${fm(t.margin.actual)} contra ${fm(t.margin.budget)}.`,
      '',
      `| Categoría | Presupuesto ${monthName(m)} | Real ${monthName(m)} | Acumulado presupuesto | Acumulado real | Semáforo |`,
      '|---|---:|---:|---:|---:|---|',
    );
    for (const row of vs.rows) {
      const cell = row.months[m - 1];
      out.push(
        `| ${row.label}${row.kind === 'ingreso' ? ' (ingreso)' : ''} | ${fm(cell?.budgetToDate ?? 0)} | ${cell?.actual === null || cell?.actual === undefined ? '—' : fm(cell.actual)} | ${fm(row.ytd.budget)} | ${fm(row.ytd.actual)} | ${LIGHT_LABEL[row.ytd.light]}${row.ytd.pct !== null ? ` (${pctText(row.ytd.pct)})` : ''} |`,
      );
    }
    const overruns = budgetOverruns(vs);
    if (overruns.length)
      out.push(
        '',
        'Se salieron del presupuesto:',
        ...overruns
          .slice(0, 6)
          .map(
            (o) =>
              `- ${o.label}: ${fm(o.actual)} contra ${fm(o.budget)} ${o.scope === 'mes' ? `en ${monthName(o.month)}` : 'en el acumulado'} (${fm(o.over)} arriba).`,
          ),
      );
    if (vs.unbudgeted.length)
      out.push(
        `Con gasto y sin presupuesto: ${vs.unbudgeted.map(budgetCategoryLabel).join(', ')}.`,
      );
  }
  if (r.payrollConfidential)
    out.push('La nómina real se compara como un solo total: el detalle lo ve quien administra.');
  out.push('Lo real es de caja (el libro de plata). Se edita en /presupuesto.');
  return out.join('\n');
}

export const budgetGet = registerTool({
  id: 'budget.get',
  description:
    'El presupuesto anual de la empresa contra lo real (de caja), por categoría y mes, con variación y semáforo (verde, amarillo, rojo) y lo que se salió del presupuesto. Úsala para «¿cómo vamos contra el presupuesto?», «¿en qué nos pasamos?», «presupuesto vs real». Sólo lectura. Si no hay presupuesto para el año, lo dice.',
  inputSchema: z.object({
    year: z.number().int().min(2020).max(2100).nullish().describe('Por defecto, el año actual.'),
    month: z
      .number()
      .int()
      .min(1)
      .max(12)
      .nullish()
      .describe('El mes a mostrar en detalle. Por defecto, el actual.'),
  }),
  outputSchema: z.object({
    budgetId: z.string().nullable(),
    status: z.string().nullable(),
    totals: z
      .object({
        income: z.object({ budget: z.number(), actual: z.number() }),
        expense: z.object({ budget: z.number(), actual: z.number() }),
      })
      .nullable(),
    overruns: z.array(z.object({ category: z.string(), budget: z.number(), actual: z.number() })),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const r = await loadBudgetReport(ctx.db, {
      year: input.year ?? Number(today.slice(0, 4)),
      today,
      viewerId: ctx.userId,
    });
    return {
      budgetId: r.budget?.id ?? null,
      status: r.budget?.status ?? null,
      totals: r.vs ? { income: r.vs.totals.income, expense: r.vs.totals.expense } : null,
      overruns: r.vs
        ? budgetOverruns(r.vs).map((o) => ({
            category: o.category,
            budget: o.budget,
            actual: o.actual,
          }))
        : [],
      markdown: budgetMarkdown(r, { month: input.month }),
    };
  },
});

export const budgetSetLine = registerTool({
  id: 'budget.set_line',
  description:
    'Fijar cuánto se presupuesta para una categoría (ventas, otros_ingresos, nomina, arriendo, servicios_publicos, proveedores, transporte, software, mercadeo… o una propia) en un mes o en todos los meses del año. Si el año no tiene presupuesto, crea un borrador. Monto 0 borra la celda. Sólo quien administra o es dueño. Requiere confirmación.',
  inputSchema: z.object({
    year: z.number().int().min(2020).max(2100).nullish().describe('Por defecto, el año actual.'),
    category: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .describe('Categoría del libro (ventas, nomina, arriendo…) o un nombre nuevo.'),
    month: z
      .number()
      .int()
      .min(1)
      .max(12)
      .nullish()
      .describe('Un mes (1–12). Vacío = todos los meses.'),
    amount: z.number().min(0).max(1e14).describe('Monto del mes en pesos.'),
  }),
  outputSchema: z.object({ budgetId: z.string(), written: z.number(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const today = bogotaToday();
    const year = input.year ?? Number(today.slice(0, 4));
    let budget = await activeBudget(ctx.db, year);
    let created = false;
    if (!budget) {
      budget = (
        await createBudget(ctx.db, { year, basis: 'desde_cero' }, { userId: ctx.userId, today })
      ).budget;
      created = true;
    }
    if (!budget) throw new NotFoundError('No pude crear el presupuesto.');
    const category = toBudgetCategory(input.category);
    if (!category) throw new ValidationError('Dime la categoría.');
    const months = input.month ? [input.month] : Array.from({ length: 12 }, (_, i) => i + 1);
    const out = await setBudgetLines(
      ctx.db,
      budget.id,
      months.map((month) => ({ category, month, amount: input.amount })),
      { userId: ctx.userId },
    );
    const what = input.month ? `${monthName(input.month)} de ${year}` : `cada mes de ${year}`;
    return {
      budgetId: budget.id,
      written: out.written + out.removed,
      markdown: `${created ? `Creé el borrador «${budget.name}» y ` : ''}${input.amount > 0 ? `fijé ${budgetCategoryLabel(category)} en ${formatMoney(input.amount)} para ${what}` : `quité ${budgetCategoryLabel(category)} de ${what}`}. Se revisa y aprueba en /presupuesto.`,
    };
  },
});
