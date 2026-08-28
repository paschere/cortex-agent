import { z } from 'zod';
import { registerTool } from '../index';
import { fetchExpensesReport } from './client';
import { COMP_SENSITIVITY_NOTE } from './sensitive';

function money(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'N/A';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export const payrollExpensesReport = registerTool({
  id: 'payroll.expenses_report',
  description:
    'See what the team spent on expenses and reimbursements, broken down month by month, by category (home office, medical, active lifestyle, ...), by client and by division, with totals and counts. ' +
    'Use this for "how much did we spend on expenses last quarter", "what are we spending on home office", "which client has the highest expenses", "how have expenses trended this year", or "who expensed the most". ' +
    'months controls the window (default 6, counting the current month); optionally filter by client or category. Amounts are USD. ' +
    COMP_SENSITIVITY_NOTE,
  inputSchema: z.object({
    months: z
      .number()
      .int()
      .min(1)
      .max(36)
      .optional()
      .describe('How many months back to include, including the current one (default 6)'),
    client: z
      .string()
      .min(1)
      .optional()
      .describe('Only expenses from people placed with this client, partial match'),
    category: z
      .string()
      .min(1)
      .optional()
      .describe('Only this expense category, partial match (e.g. "Home Office")'),
  }),
  outputSchema: z.object({
    report: z.any(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const data = await fetchExpensesReport(ctx, input);
    const t = data.totals ?? ({} as (typeof data)['totals']);
    const byMonth = Array.isArray(data.byMonth) ? data.byMonth : [];
    const byCategory = Array.isArray(data.byCategory) ? data.byCategory : [];
    const byClient = Array.isArray(data.byClient) ? data.byClient : [];

    const scope = [
      input.client ? `client "${input.client}"` : null,
      input.category ? `category "${input.category}"` : null,
    ]
      .filter(Boolean)
      .join(', ');

    const lines: string[] = [];
    lines.push(
      `**Expenses — last ${t.months ?? input.months ?? 6} months${scope ? ` (${scope})` : ''}**`,
    );
    lines.push('');
    lines.push(
      `- **${money(t.totalUsd)}** USD across **${t.count ?? 0}** expenses from ${t.employees ?? 0} people`,
    );
    lines.push(`- Avg ${money(t.avgPerMonthUsd)}/month · ${money(t.avgPerExpenseUsd)} per expense`);

    const lastMonth = byMonth[byMonth.length - 1];
    const prevMonth = byMonth[byMonth.length - 2];
    if (byMonth.length >= 2 && lastMonth && prevMonth) {
      const last = lastMonth;
      const prev = prevMonth;
      const delta =
        prev.totalUsd > 0 ? Math.round(((last.totalUsd - prev.totalUsd) / prev.totalUsd) * 100) : 0;
      lines.push(
        `- Latest month (${last.month}): ${money(last.totalUsd)} — ${delta >= 0 ? '+' : ''}${delta}% vs ${prev.month}`,
      );
    }

    if (byMonth.length) {
      lines.push('');
      lines.push('**By month:**');
      lines.push('| Month | Expenses | Total USD |');
      lines.push('| --- | --- | --- |');
      for (const m of byMonth) {
        lines.push(`| ${m.month} | ${m.count} | ${money(m.totalUsd)} |`);
      }
    }

    if (byCategory.length) {
      lines.push('');
      lines.push('**By category:**');
      lines.push('| Category | Count | Total USD | Share |');
      lines.push('| --- | --- | --- | --- |');
      for (const c of byCategory.slice(0, 10)) {
        lines.push(`| ${c.category} | ${c.count} | ${money(c.totalUsd)} | ${c.sharePct}% |`);
      }
    }

    if (byClient.length) {
      lines.push('');
      lines.push(
        `**Top clients:** ${byClient
          .slice(0, 5)
          .map((c) => `${c.client} ${money(c.totalUsd)}`)
          .join(' · ')}`,
      );
    }

    lines.push('');
    lines.push(
      '_Spend data is confidential — do not share externally without explicit confirmation._',
    );

    return { report: data, markdown: lines.join('\n') };
  },
});
