import { z } from 'zod';
import { registerTool } from '../index';
import { fetchExpensesReport, fetchPayrollStats, fetchTeamAssignments } from './client';
import { BAMBOO_BOUNDARY_NOTE, COMP_SENSITIVITY_NOTE } from './sensitive';

/**
 * payroll.client_report — everything about one client's team in a single call:
 * the named roster with what each person costs, the monthly/annual totals,
 * expenses attributed to that client, and the recent cost trend.
 *
 * Exists because the report people actually ask for ("give me the full picture
 * of <client>") needed three separate calls plus manual stitching, which made
 * models give up and answer "I don't have that data".
 */

function money(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export const payrollClientReport = registerTool({
  id: 'payroll.client_report',
  description:
    'The COST side of one client account in a single call: every person assigned to that client by name with their role, seniority in the account and monthly cost, the total monthly and annualized cost, the expenses charged against that client, and the recent cost trend. ' +
    'Use this whenever someone asks for a report, a summary, the roster, the cost or "everything we have" about a client (e.g. "give me a full report on PureCars"). Prefer it over calling the roster, expenses and stats tools separately. ' +
    'It does NOT carry what Zipdev charges that client or the margin on the account — those are bill rates, and they live in BambooHR (bamboo.compensation_report, filtered to the client). Do not call this a complete account picture without them. ' +
    `Combine with payroll.cost_projection for a forward-looking model. ${BAMBOO_BOUNDARY_NOTE} ${COMP_SENSITIVITY_NOTE}`,
  inputSchema: z.object({
    client: z.string().min(2).describe('Client name as it appears in payroll (the "department" field)'),
    expenseMonths: z.number().int().min(1).max(24).default(6),
    periods: z.number().int().min(1).max(24).default(6),
  }),
  outputSchema: z.object({
    client: z.string(),
    asOf: z.string(),
    headcount: z.number(),
    monthlyCostUsd: z.number(),
    annualizedCostUsd: z.number(),
    avgMonthlyCostUsd: z.number(),
    members: z.array(z.any()),
    byDivision: z.array(z.any()),
    byCurrency: z.array(z.any()),
    expenses: z.any(),
    costTrend: z.array(z.any()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 15 },
  handler: async (input, ctx) => {
    const months = input.expenseMonths ?? 6;
    const periods = input.periods ?? 6;

    // Roster is the backbone; expenses/stats are best-effort so a partial
    // outage still produces a useful report instead of an error.
    const roster = await fetchTeamAssignments(ctx, { client: input.client, limit: 200 });
    const [expenses, stats] = await Promise.all([
      fetchExpensesReport(ctx, { months, client: input.client }).catch(() => null),
      fetchPayrollStats(ctx, { periods, client: input.client }).catch(() => null),
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = roster as any;
    const members = (r.members ?? []) as Array<Record<string, unknown>>;
    const monthlyCostUsd = Number(r.totals?.monthlyCostUsd ?? 0);
    const headcount = Number(r.totals?.members ?? members.length);
    const avgMonthlyCostUsd = Number(r.totals?.avgMonthlyCostUsd ?? 0);
    const annualizedCostUsd = monthlyCostUsd * 12;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = expenses as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s = stats as any;
    const costTrend = (s?.series ?? []) as Array<Record<string, unknown>>;

    const lines: string[] = [];
    lines.push(`# ${input.client} — team & cost report`);
    lines.push('');
    lines.push(
      `**${headcount}** people · **${money(monthlyCostUsd)}/month** · **${money(annualizedCostUsd)}/year** (avg ${money(avgMonthlyCostUsd)} per person)`,
    );
    if (headcount === 0) {
      lines.push('');
      lines.push(
        `No one is currently assigned to "${input.client}" in payroll. Check the exact client name with payroll.team_assignments (no filter) — the field is the person's department.`,
      );
      return {
        client: input.client,
        asOf: String(r.asOf ?? new Date().toISOString()),
        headcount: 0,
        monthlyCostUsd: 0,
        annualizedCostUsd: 0,
        avgMonthlyCostUsd: 0,
        members: [],
        byDivision: [],
        byCurrency: [],
        expenses: null,
        costTrend: [],
        markdown: lines.join('\n'),
      };
    }

    lines.push('');
    lines.push('## Team');
    lines.push('| Person | Role | Division | Since | Monthly (USD) |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const m of members) {
      const since = m.hireDate ? String(m.hireDate).slice(0, 10) : '—';
      lines.push(
        `| ${m.name ?? '—'} | ${m.jobTitle ?? '—'} | ${m.division ?? '—'} | ${since} | ${money(m.payRateUsd as number)} |`,
      );
    }

    if ((r.byDivision ?? []).length > 0) {
      lines.push('');
      lines.push(
        `**By division:** ${(r.byDivision as Array<Record<string, unknown>>)
          .map((d) => `${d.division} ${d.count}`)
          .join(' · ')}`,
      );
    }
    if ((r.byCurrency ?? []).length > 0) {
      lines.push(
        `**By currency:** ${(r.byCurrency as Array<Record<string, unknown>>)
          .map((c) => `${c.currency} ${c.count}`)
          .join(' · ')}`,
      );
    }

    lines.push('');
    lines.push(`## Expenses (last ${months} months)`);
    if (!e) {
      lines.push('Expense data unavailable right now.');
    } else if (Number(e.totals?.totalUsd ?? 0) === 0) {
      lines.push('No expenses charged against this client in the window.');
    } else {
      lines.push(
        `Total **${money(e.totals?.totalUsd)}** across ${e.totals?.count ?? 0} items (avg ${money(e.totals?.avgPerMonthUsd ?? e.totals?.totalUsd / months)}/month).`,
      );
      const byCat = (e.byCategory ?? []) as Array<Record<string, unknown>>;
      if (byCat.length > 0) {
        lines.push('');
        lines.push('| Category | Total (USD) |');
        lines.push('| --- | --- |');
        for (const c of byCat.slice(0, 8)) {
          lines.push(`| ${c.category ?? '—'} | ${money(c.totalUsd as number)} |`);
        }
      }
    }

    if (costTrend.length > 0) {
      lines.push('');
      lines.push(`## Cost trend (last ${costTrend.length} periods)`);
      lines.push('| Period | Gross (USD) | Headcount |');
      lines.push('| --- | --- | --- |');
      for (const p of costTrend) {
        lines.push(`| ${p.period ?? '—'} | ${money(p.grossUsd as number)} | ${p.headcount ?? '—'} |`);
      }
    }

    return {
      client: input.client,
      asOf: String(r.asOf ?? new Date().toISOString()),
      headcount,
      monthlyCostUsd,
      annualizedCostUsd,
      avgMonthlyCostUsd,
      members,
      byDivision: (r.byDivision ?? []) as Array<Record<string, unknown>>,
      byCurrency: (r.byCurrency ?? []) as Array<Record<string, unknown>>,
      expenses: e,
      costTrend,
      markdown: lines.join('\n'),
    };
  },
});
