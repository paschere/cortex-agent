import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';

function fmtKpis(kpis: any): string {
  if (!kpis || typeof kpis !== 'object') return '';
  const lines: string[] = [];
  const push = (label: string, key: string, suffix = '') => {
    const v = kpis[key];
    if (v !== undefined && v !== null) lines.push(`- ${label}: ${v}${suffix}`);
  };
  push('Open requisitions', 'currentReqsOpen');
  push('Open seats', 'currentOpenSeats');
  push('Opened in period', 'openedInPeriod');
  push('Closed in period', 'reqsClosed');
  push('Closed won', 'reqsClosedWon');
  push('Closed lost', 'reqsClosedLost');
  push('Lost rate', 'lostRate', '%');
  push('Quality candidate', 'qualityCandidatePercent', '%');
  push('Days to acceptance', 'daysToAcceptance');
  push('Offers accepted', 'offersAccepted');
  push('Margin', 'marginDollars', ' USD');
  push('Margin', 'marginPercent', '%');
  push('Acceptance rate', 'acceptanceRate', '%');
  return lines.join('\n');
}

export const recruiterAnalytics = registerTool({
  id: 'recruit.recruiter_analytics',
  description:
    'Get recruiter analytics from the zipdev-matcher (KPIs: time-to-fill / days-to-acceptance, conversion/acceptance rates, requisition counts, margins, status breakdown). ' +
    'Pass `recruiterId` to scope to a single recruiter (returns per-recruiter detail incl. their jobs, hires and presentations). ' +
    'Omit `recruiterId` for the org-wide view with per-recruiter and per-pod rollups. Requires ADMIN session on the matcher.',
  inputSchema: z.object({
    recruiterId: z.string().optional(),
  }),
  outputSchema: z.object({
    analytics: z.any(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input) => {
    const path = input.recruiterId
      ? `/api/admin/recruiter-analytics/${encodeURIComponent(input.recruiterId)}`
      : '/api/admin/recruiter-analytics';
    const analytics = await matcherFetch(path, { method: 'GET' });

    const parts: string[] = [];
    if (analytics?.recruiter) {
      parts.push(`### Recruiter analytics — ${analytics.recruiter.name ?? analytics.recruiter.id}`);
    } else {
      parts.push('### Recruiter analytics (org-wide)');
    }
    if (analytics?.range) {
      parts.push(
        `Period: ${analytics.range.dateFrom} → ${analytics.range.dateTo} (${analytics.range.periodDays} days)`,
      );
    }
    const kpis = fmtKpis(analytics?.kpis);
    if (kpis) parts.push(`\n**KPIs**\n${kpis}`);

    if (Array.isArray(analytics?.perRecruiter) && analytics.perRecruiter.length) {
      const rows = analytics.perRecruiter
        .slice(0, 15)
        .map(
          (r: any) =>
            `- ${r.name ?? r.recruiterId}: ${r.openReqs ?? 0} open, ${r.hires ?? 0} hires, $${r.marginDollars ?? 0} margin`,
        )
        .join('\n');
      parts.push(`\n**Per recruiter**\n${rows}`);
    }

    return { analytics, markdown: parts.join('\n') };
  },
});
