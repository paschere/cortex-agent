import { z } from 'zod';
import { registerTool } from '../index';
import { matcherFetch } from './client';
import { SOURCE, buildMeta, matcherLink, metaSchema, provenanceFooter } from './shape';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    'Recruiter KPIs from the matcher: time-to-fill / days-to-acceptance, acceptance and loss rates, requisitions opened and closed in the period, margins, and the status breakdown. ' +
    'Pass `recruiterId` for one recruiter (their jobs, hires and presentations); omit it for the org-wide view with per-recruiter and per-pod rollups (the markdown lists the top 15 — read meta.totalAvailable before saying "everyone"). Requires an ADMIN session on the matcher, so it may return 401 for a service caller. ' +
    'PROVENANCE: every figure is computed by the matcher service over its own requisition and placement records for the period in `range` — always state the period alongside the number, since "8 hires" means nothing without it.',
  inputSchema: z.object({
    recruiterId: z.string().optional(),
  }),
  outputSchema: z.object({
    analytics: z.any(),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input) => {
    const path = input.recruiterId
      ? `/api/admin/recruiter-analytics/${encodeURIComponent(input.recruiterId)}`
      : '/api/admin/recruiter-analytics';
    const analytics = await matcherFetch(path, { method: 'GET' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const perRecruiter: any[] = Array.isArray(analytics?.perRecruiter)
      ? analytics.perRecruiter
      : [];
    const shown = Math.min(perRecruiter.length, 15);

    const meta = buildMeta({
      endpoint: path,
      totalAvailable: perRecruiter.length || 1,
      returned: shown || 1,
      truncated: perRecruiter.length > shown,
      period: analytics?.range ?? null,
      links: { matcher: matcherLink('/recruiter-hub') },
      provenance: {
        'kpis.*, perRecruiter.*': `${SOURCE.matcher} — computed over the matcher's requisition, presentation and placement records`,
        'range.*': `${SOURCE.matcher} — the reporting window every figure is scoped to`,
      },
      dataQuality: [
        ...(analytics?.range
          ? [
              `All figures cover ${analytics.range.dateFrom} → ${analytics.range.dateTo} (${analytics.range.periodDays} days). Quote the period with the number.`,
            ]
          : [
              'No reporting period was returned with these figures — do not describe them as "current" without one.',
            ]),
        ...(perRecruiter.length > shown
          ? [`Only the top ${shown} of ${perRecruiter.length} recruiters are shown in the summary.`]
          : []),
      ],
    });

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

    if (perRecruiter.length) {
      const rows = perRecruiter
        .slice(0, shown)
        .map(
          (r) =>
            `- ${r.name ?? r.recruiterId}: ${r.openReqs ?? 0} open, ${r.hires ?? 0} hires, $${r.marginDollars ?? 0} margin`,
        )
        .join('\n');
      parts.push(`\n**Per recruiter**\n${rows}`);
    }
    parts.push('');
    parts.push(provenanceFooter(meta));

    return { analytics, meta, markdown: parts.join('\n') };
  },
});
