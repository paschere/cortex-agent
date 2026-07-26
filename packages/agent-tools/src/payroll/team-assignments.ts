import { z } from 'zod';
import { registerTool } from '../index';
import { fetchTeamAssignments } from './client';
import { COMP_SENSITIVITY_NOTE } from './sensitive';

function money(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'N/A';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export const payrollTeamAssignments = registerTool({
  id: 'payroll.team_assignments',
  description:
    'List the people currently working at Zipdev and which client each one is placed with — name, client, division (Tech / Non-tech / Internal), job title, currency, start date, how long they have been here, and their monthly rate. ' +
    'Use this for questions like "who is assigned to <client>", "who works on the <client> team", "how many people do we have on Tech", "who joined recently", or "what does the team for <client> cost us per month". ' +
    'Filter with client, division, or q (a name / email / job-title search). ' +
    COMP_SENSITIVITY_NOTE,
  inputSchema: z.object({
    client: z
      .string()
      .min(1)
      .optional()
      .describe('Client name to filter by, partial match (e.g. "PureCars")'),
    division: z
      .string()
      .min(1)
      .optional()
      .describe('Division to filter by, partial match: Tech, Non-tech, Internal'),
    q: z
      .string()
      .min(1)
      .optional()
      .describe('Free-text search over name, email and job title'),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  outputSchema: z.object({
    assignments: z.any(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const data = await fetchTeamAssignments(ctx, input);
    const t = data.totals ?? ({} as (typeof data)['totals']);
    const members = Array.isArray(data.members) ? data.members : [];

    const scope = [
      input.client ? `client "${input.client}"` : null,
      input.division ? `division "${input.division}"` : null,
      input.q ? `matching "${input.q}"` : null,
    ]
      .filter(Boolean)
      .join(', ');

    const lines: string[] = [];
    lines.push(`**Team assignments${scope ? ` — ${scope}` : ''}**`);
    lines.push('');
    lines.push(
      `- **${t.members ?? 0}** active people across **${t.clients ?? 0}** clients and ${t.divisions ?? 0} divisions (${t.newHires ?? 0} new hires)`,
    );
    lines.push(
      `- Monthly cost: **${money(t.monthlyCostUsd)}** USD (avg ${money(t.avgMonthlyCostUsd)} across ${t.withKnownRate ?? 0} people with a known rate)`,
    );

    const byClient = Array.isArray(data.byClient) ? data.byClient.slice(0, 10) : [];
    if (byClient.length) {
      lines.push('');
      lines.push('**By client (top 10):**');
      lines.push('| Client | People | Monthly USD |');
      lines.push('| --- | --- | --- |');
      for (const r of byClient) {
        lines.push(`| ${r.client} | ${r.count} | ${money(r.monthlyCostUsd)} |`);
      }
    }

    const byDivision = Array.isArray(data.byDivision) ? data.byDivision : [];
    if (byDivision.length) {
      lines.push('');
      lines.push(
        `**By division:** ${byDivision.map((d) => `${d.division} ${d.count}`).join(' · ')}`,
      );
    }

    if (members.length) {
      const shown = members.slice(0, 25);
      lines.push('');
      lines.push(`**People (${shown.length} of ${members.length}):**`);
      lines.push('| Name | Client | Division | Title | Start | Rate |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const m of shown) {
        const start = m.hireDate ? m.hireDate.slice(0, 10) : 'N/A';
        const rate =
          m.payRate == null
            ? 'N/A'
            : `${Math.round(m.payRate).toLocaleString('en-US')} ${m.currency ?? ''}`.trim();
        lines.push(
          `| ${m.name} | ${m.client ?? '—'} | ${m.division ?? '—'} | ${m.jobTitle ?? '—'} | ${start} | ${rate} |`,
        );
      }
      if (members.length > shown.length) {
        lines.push('');
        lines.push(`_${members.length - shown.length} more not shown — narrow the filter._`);
      }
    } else {
      lines.push('');
      lines.push('_No active team members matched._');
    }

    lines.push('');
    lines.push('_Compensation figures are confidential — do not share externally without explicit confirmation._');

    return { assignments: data, markdown: lines.join('\n') };
  },
});
