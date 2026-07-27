import { z } from 'zod';
import { registerTool } from '../index';
import { fetchExpensesReport, fetchTeamAssignments } from './client';
import { COMP_SENSITIVITY_NOTE } from './sensitive';

/**
 * payroll.cost_projection — forward-looking cost model built from the REAL
 * current roster, not from guesses.
 *
 * The baseline (headcount and monthly cost) comes from payroll; the future
 * comes from explicit, user-visible assumptions. Every assumption is echoed
 * back in the output so the number can never be presented as a fact when it
 * is a scenario.
 */

function money(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

const ScenarioSchema = z.object({
  name: z.string(),
  salaryInflationPct: z.number(),
  headcountGrowthPct: z.number(),
  years: z.array(
    z.object({
      year: z.number(),
      headcount: z.number(),
      payrollUsd: z.number(),
      expensesUsd: z.number(),
      totalUsd: z.number(),
      changePct: z.number(),
    }),
  ),
  totalUsd: z.number(),
});

export const payrollCostProjection = registerTool({
  id: 'payroll.cost_projection',
  description:
    'Project what a team will cost over the next few years, starting from the real payroll baseline (current headcount and monthly cost, optionally filtered to one client or division) and applying explicit assumptions: salary inflation, headcount growth and expense growth. ' +
    'Returns a year-by-year series for three scenarios (conservative / base / aggressive) plus the assumptions used — ready to chart or drop into a report. Use it for "what will this team cost us in 3 years", "project the cost of <client>", or budget planning. ' +
    'ALWAYS present the result as a scenario with its assumptions stated, never as a prediction, and offer to re-run with the user\'s own numbers. ' +
    COMP_SENSITIVITY_NOTE,
  inputSchema: z.object({
    client: z.string().optional().describe('Scope to one client (payroll "department")'),
    division: z.string().optional().describe('Scope to Tech / Non-tech / Internal'),
    years: z.number().int().min(1).max(5).default(3),
    salaryInflationPct: z
      .number()
      .min(0)
      .max(40)
      .default(6)
      .describe('Annual salary increase for the base scenario, in percent'),
    headcountGrowthPct: z
      .number()
      .min(-50)
      .max(100)
      .default(0)
      .describe('Annual headcount change for the base scenario, in percent'),
    expenseGrowthPct: z.number().min(-50).max(100).default(5),
    includeExpenses: z.boolean().default(true),
  }),
  outputSchema: z.object({
    scope: z.string(),
    baseline: z.object({
      asOf: z.string(),
      headcount: z.number(),
      monthlyCostUsd: z.number(),
      annualPayrollUsd: z.number(),
      annualExpensesUsd: z.number(),
      annualTotalUsd: z.number(),
      avgCostPerPersonUsd: z.number(),
    }),
    assumptions: z.record(z.union([z.string(), z.number(), z.boolean()])),
    scenarios: z.array(ScenarioSchema),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 15 },
  handler: async (input, ctx) => {
    const years = input.years ?? 3;
    const baseInflation = input.salaryInflationPct ?? 6;
    const baseGrowth = input.headcountGrowthPct ?? 0;
    const expenseGrowth = input.expenseGrowthPct ?? 5;
    const includeExpenses = input.includeExpenses ?? true;

    const roster = await fetchTeamAssignments(ctx, {
      client: input.client,
      division: input.division,
      limit: 500,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = roster as any;
    const headcount = Number(r.totals?.members ?? 0);
    const monthlyCostUsd = Number(r.totals?.monthlyCostUsd ?? 0);
    const annualPayrollUsd = monthlyCostUsd * 12;

    let annualExpensesUsd = 0;
    if (includeExpenses) {
      const exp = await fetchExpensesReport(ctx, { months: 12, client: input.client }).catch(
        () => null,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      annualExpensesUsd = Number((exp as any)?.totals?.totalUsd ?? 0);
    }

    const scope =
      [input.client ? `client "${input.client}"` : null, input.division ? `division "${input.division}"` : null]
        .filter(Boolean)
        .join(' · ') || 'the whole team';

    const build = (name: string, inflation: number, growth: number) => {
      const yearRows: z.infer<typeof ScenarioSchema>['years'] = [];
      let hc = headcount;
      let payroll = annualPayrollUsd;
      let expenses = annualExpensesUsd;
      let prevTotal = annualPayrollUsd + annualExpensesUsd;
      for (let y = 1; y <= years; y++) {
        hc = hc * (1 + growth / 100);
        // Cost scales with both per-person increases and headcount change.
        payroll = payroll * (1 + inflation / 100) * (1 + growth / 100);
        expenses = expenses * (1 + expenseGrowth / 100) * (1 + growth / 100);
        const total = payroll + expenses;
        yearRows.push({
          year: y,
          headcount: Math.round(hc * 10) / 10,
          payrollUsd: Math.round(payroll),
          expensesUsd: Math.round(expenses),
          totalUsd: Math.round(total),
          changePct: prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 1000) / 10 : 0,
        });
        prevTotal = total;
      }
      return {
        name,
        salaryInflationPct: inflation,
        headcountGrowthPct: growth,
        years: yearRows,
        totalUsd: yearRows.reduce((sum, y) => sum + y.totalUsd, 0),
      };
    };

    const scenarios = [
      build('Conservative', Math.max(0, baseInflation - 3), Math.max(-50, baseGrowth - 10)),
      build('Base', baseInflation, baseGrowth),
      build('Aggressive', baseInflation + 4, baseGrowth + 15),
    ];

    const annualTotalUsd = annualPayrollUsd + annualExpensesUsd;
    const lines: string[] = [];
    lines.push(`# ${years}-year cost projection — ${scope}`);
    lines.push('');
    lines.push(
      `**Baseline today:** ${headcount} people · ${money(monthlyCostUsd)}/month · ${money(annualPayrollUsd)} payroll/year` +
        (includeExpenses ? ` + ${money(annualExpensesUsd)} expenses/year = **${money(annualTotalUsd)}**` : ''),
    );
    lines.push('');
    lines.push(
      `_Scenarios, not forecasts. Base assumes ${baseInflation}% salary inflation and ${baseGrowth}% headcount change per year; expenses grow ${expenseGrowth}%._`,
    );
    for (const s of scenarios) {
      lines.push('');
      lines.push(
        `## ${s.name} — ${s.salaryInflationPct}% salary / ${s.headcountGrowthPct}% headcount per year`,
      );
      lines.push('| Year | Headcount | Payroll | Expenses | Total | Δ |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const y of s.years) {
        lines.push(
          `| +${y.year} | ${y.headcount} | ${money(y.payrollUsd)} | ${money(y.expensesUsd)} | **${money(y.totalUsd)}** | ${y.changePct > 0 ? '+' : ''}${y.changePct}% |`,
        );
      }
      lines.push(`Cumulative ${years}-year cost: **${money(s.totalUsd)}**`);
    }

    return {
      scope,
      baseline: {
        asOf: String(r.asOf ?? new Date().toISOString()),
        headcount,
        monthlyCostUsd,
        annualPayrollUsd,
        annualExpensesUsd,
        annualTotalUsd,
        avgCostPerPersonUsd: Number(r.totals?.avgMonthlyCostUsd ?? 0),
      },
      assumptions: {
        years,
        salaryInflationPct: baseInflation,
        headcountGrowthPct: baseGrowth,
        expenseGrowthPct: expenseGrowth,
        includeExpenses,
        note: 'Scenarios derived from the current payroll baseline; not a forecast.',
      },
      scenarios,
      markdown: lines.join('\n'),
    };
  },
});
