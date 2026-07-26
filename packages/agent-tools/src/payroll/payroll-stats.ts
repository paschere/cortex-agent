import { z } from 'zod';
import { registerTool } from '../index';
import { fetchPayrollStats } from './client';
import { COMP_SENSITIVITY_NOTE } from './sensitive';

function money(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'N/A';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export const payrollStats = registerTool({
  id: 'payroll.payroll_stats',
  description:
    'Get how much payroll costs the company over time: one row per completed pay period with the total paid, how many people were paid, the average cost per person, and the split between regular pay, bonuses, reimbursements and deductions — plus totals by currency, division and client. It is a ready-to-chart time series (oldest period first). ' +
    'Use this for "show me the payroll cost trend", "how much did we pay out last period", "is our payroll going up", "how much does the Tech division cost", or "what is our average cost per person". ' +
    'periods controls how many recent completed pay periods to include (default 12). Only completed payrolls are counted; amounts are USD. ' +
    COMP_SENSITIVITY_NOTE,
  inputSchema: z.object({
    periods: z
      .number()
      .int()
      .min(1)
      .max(36)
      .optional()
      .describe('How many recent completed pay periods to include (default 12)'),
    division: z
      .string()
      .min(1)
      .optional()
      .describe('Only people in this division, partial match: Tech, Non-tech, Internal'),
    client: z
      .string()
      .min(1)
      .optional()
      .describe('Only people placed with this client, partial match'),
  }),
  outputSchema: z.object({
    stats: z.any(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const data = await fetchPayrollStats(ctx, input);
    const t = data.totals ?? ({} as (typeof data)['totals']);
    const series = Array.isArray(data.series) ? data.series : [];

    const scope = [
      input.division ? `division "${input.division}"` : null,
      input.client ? `client "${input.client}"` : null,
    ]
      .filter(Boolean)
      .join(', ');

    const lines: string[] = [];
    lines.push(
      `**Payroll cost — last ${t.periods ?? series.length} completed periods${scope ? ` (${scope})` : ''}**`,
    );
    lines.push('');

    if (!series.length) {
      lines.push('_No completed payrolls matched._');
      return { stats: data, markdown: lines.join('\n') };
    }

    lines.push(
      `- Total paid: **${money(t.grossTotalUsd)}** USD | avg ${money(t.avgPerPeriodUsd)} per period`,
    );
    lines.push(
      `- Latest period: **${money(t.latestPeriodUsd)}** (${(t.changePct ?? 0) >= 0 ? '+' : ''}${t.changePct ?? 0}% vs previous ${money(t.previousPeriodUsd)})`,
    );
    lines.push(`- Peak headcount in a period: ${t.peakHeadcount ?? 0}`);

    lines.push('');
    lines.push('**Per period (oldest → newest):**');
    lines.push('| Period | Gross USD | People | Avg/person | Regular | Bonuses | Reimb. |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const s of series) {
      lines.push(
        `| ${s.period} | ${money(s.grossUsd)} | ${s.headcount} | ${money(s.avgCostPerPersonUsd)} | ${money(s.regularPayUsd)} | ${money(s.bonusesUsd)} | ${money(s.reimbursementsUsd)} |`,
      );
    }

    const byDivision = Array.isArray(data.byDivision) ? data.byDivision : [];
    if (byDivision.length) {
      lines.push('');
      lines.push(
        `**By division:** ${byDivision
          .map((d) => `${d.division} ${money(d.amountUsd)} (${d.sharePct}%)`)
          .join(' · ')}`,
      );
    }

    const byCurrency = Array.isArray(data.byCurrency) ? data.byCurrency : [];
    if (byCurrency.length) {
      lines.push(
        `**By currency:** ${byCurrency
          .map((c) => `${c.currency} ${money(c.amountUsd)} (${c.headcount} people)`)
          .join(' · ')}`,
      );
    }

    const byClient = Array.isArray(data.byClient) ? data.byClient : [];
    if (byClient.length) {
      lines.push(
        `**Top clients by cost:** ${byClient
          .slice(0, 5)
          .map((c) => `${c.client} ${money(c.amountUsd)}`)
          .join(' · ')}`,
      );
    }

    lines.push('');
    lines.push('_Payroll cost is confidential — do not share externally without explicit confirmation._');

    return { stats: data, markdown: lines.join('\n') };
  },
});
