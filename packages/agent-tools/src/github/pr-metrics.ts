import { z } from 'zod';
import { registerTool } from '../index';
import { githubFetch } from './client';

const Output = z.object({
  windowDays: z.number(),
  since: z.string(),
  mergedCount: z.number(),
  avgTimeToMergeHours: z.number().nullable(),
  medianTimeToMergeHours: z.number().nullable(),
  // Open counts are scoped to PRs active (updated) within the window — paging stops
  // once a page predates `since`, so stale-but-open PRs are not included.
  openCountInWindow: z.number(),
  unreviewedOpenCountInWindow: z.number(),
  reviewThroughput: z.number(),
  truncated: z.boolean(),
  markdown: z.string(),
});

const MAX_PAGES = 6; // 100 PRs/page → up to 600 PRs scanned.
const UNREVIEWED_CHECK_LIMIT = 30; // cap per-PR review lookups for open PRs.

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 0) return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
  return s[mid] ?? null;
}

export const prMetrics = registerTool({
  id: 'github.pr_metrics',
  description:
    'Pull-request health metrics over a window: average and median time-to-merge (hours) for PRs merged in-window, count of open PRs active in-window, how many of those have no reviews yet, and review throughput (reviews submitted across the sampled open PRs). Open counts are window-scoped.',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    windowDays: z.number().int().min(1).max(365).default(30),
  }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'github', scopes: ['repo'] }],
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    const windowDays = input.windowDays ?? 30;
    const base = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    let truncated = false;

    type Pr = {
      number: number;
      state: string;
      created_at: string;
      merged_at: string | null;
      updated_at: string;
    };

    const mergeDurationsHours: number[] = [];
    const openPrNumbers: number[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await githubFetch<Pr[]>(
        ctx,
        `${base}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
      );
      let reachedWindow = false;
      for (const p of data) {
        if (p.state === 'open') openPrNumbers.push(p.number);
        if (p.merged_at && p.merged_at >= since) {
          const hrs =
            (new Date(p.merged_at).getTime() - new Date(p.created_at).getTime()) / 3_600_000;
          if (Number.isFinite(hrs) && hrs >= 0) mergeDurationsHours.push(hrs);
        }
        if (p.updated_at < since) reachedWindow = true;
      }
      if (reachedWindow || data.length < 100) break;
      if (page === MAX_PAGES) truncated = true;
    }

    // For open PRs, count those with zero reviews and total reviews submitted.
    type Review = { id: number };
    let unreviewedOpenCount = 0;
    let reviewThroughput = 0;
    const toCheck = openPrNumbers.slice(0, UNREVIEWED_CHECK_LIMIT);
    if (openPrNumbers.length > UNREVIEWED_CHECK_LIMIT) truncated = true;
    for (const num of toCheck) {
      const reviews = await githubFetch<Review[]>(ctx, `${base}/pulls/${num}/reviews?per_page=100`);
      if (reviews.length === 0) unreviewedOpenCount += 1;
      reviewThroughput += reviews.length;
    }

    if (truncated) {
      ctx.logger.info(
        {
          owner: input.owner,
          repo: input.repo,
          windowDays,
          maxPages: MAX_PAGES,
          reviewCheckLimit: UNREVIEWED_CHECK_LIMIT,
        },
        'github.pr_metrics hit a cap — metrics computed over a truncated sample',
      );
    }

    const avg =
      mergeDurationsHours.length > 0
        ? mergeDurationsHours.reduce((a, b) => a + b, 0) / mergeDurationsHours.length
        : null;
    const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

    const summary = {
      windowDays,
      since,
      mergedCount: mergeDurationsHours.length,
      avgTimeToMergeHours: round1(avg),
      medianTimeToMergeHours: round1(median(mergeDurationsHours)),
      openCountInWindow: openPrNumbers.length,
      unreviewedOpenCountInWindow: unreviewedOpenCount,
      reviewThroughput,
      truncated,
    };

    const markdown = [
      `## PR metrics for ${input.owner}/${input.repo} — last ${windowDays}d`,
      '',
      `- Merged PRs: ${summary.mergedCount}`,
      `- Avg time-to-merge: ${summary.avgTimeToMergeHours ?? 'n/a'}h`,
      `- Median time-to-merge: ${summary.medianTimeToMergeHours ?? 'n/a'}h`,
      `- Open PRs (active in window): ${summary.openCountInWindow}`,
      `- Open PRs without reviews: ${summary.unreviewedOpenCountInWindow}`,
      `- Reviews submitted (sampled open PRs): ${summary.reviewThroughput}`,
    ].join('\n');

    return { ...summary, markdown };
  },
});
