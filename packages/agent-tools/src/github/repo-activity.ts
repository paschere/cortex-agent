import { z } from 'zod';
import { registerTool } from '../index';
import { githubFetch } from './client';

const Output = z.object({
  windowDays: z.number(),
  since: z.string(),
  // "InWindow" counts are scoped to items active (updated) within the window — we
  // stop paging once a page predates `since`, so stale-but-open items are excluded.
  openPullRequestsInWindow: z.number(),
  mergedPullRequests: z.number(),
  recentCommits: z.number(),
  openIssuesInWindow: z.number(),
  closedIssues: z.number(),
  contributors: z.number(),
  languages: z.record(z.string(), z.number()),
  truncated: z.boolean(),
  markdown: z.string(),
});

const MAX_PAGES = 6; // 100 items/page → up to 600 items aggregated per dimension.

function renderActivity(o: Omit<z.infer<typeof Output>, 'markdown'>, repo: string): string {
  const langs = Object.entries(o.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, bytes]) => `${name} (${bytes.toLocaleString()}B)`)
    .join(', ');
  return [
    `## Activity for ${repo} — last ${o.windowDays}d`,
    '',
    `- Open PRs (active in window): ${o.openPullRequestsInWindow}`,
    `- Merged PRs (window): ${o.mergedPullRequests}`,
    `- Commits (window): ${o.recentCommits}`,
    `- Open issues (active in window): ${o.openIssuesInWindow}`,
    `- Closed issues (window): ${o.closedIssues}`,
    `- Contributors: ${o.contributors}`,
    `- Top languages: ${langs || 'n/a'}`,
  ].join('\n');
}

export const repoActivity = registerTool({
  id: 'github.repo_activity',
  description:
    'Summarize repository activity over a window (days): open PRs/issues active in-window, PRs merged in-window, commits in-window, issues closed in-window, contributor count, and language breakdown. Open counts are window-scoped (items not touched within the window are excluded). Aggregates up to ~600 items per dimension.',
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

    // --- Commits in window ---
    type Commit = { author: { login: string } | null };
    let recentCommits = 0;
    const contributors = new Set<string>();
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await githubFetch<Commit[]>(
        ctx,
        `${base}/commits?since=${encodeURIComponent(since)}&per_page=100&page=${page}`,
      );
      recentCommits += data.length;
      for (const c of data) if (c.author?.login) contributors.add(c.author.login);
      if (data.length < 100) break;
      if (page === MAX_PAGES) truncated = true;
    }

    // --- Pull requests (open-in-window count + merged-in-window count) ---
    type Pr = { state: string; merged_at: string | null; updated_at: string };
    let openPullRequestsInWindow = 0;
    let mergedPullRequests = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await githubFetch<Pr[]>(
        ctx,
        `${base}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
      );
      let reachedWindow = false;
      for (const p of data) {
        if (p.state === 'open') openPullRequestsInWindow += 1;
        if (p.merged_at && p.merged_at >= since) mergedPullRequests += 1;
        if (p.updated_at < since) reachedWindow = true;
      }
      // Sorted by updated desc: once a page predates the window, older pages add no merges.
      if (reachedWindow || data.length < 100) break;
      if (page === MAX_PAGES) truncated = true;
    }

    // --- Issues (open-in-window count + closed-in-window count), excluding PRs ---
    // The `since` filter scopes results to issues updated within the window, so the
    // open tally counts only issues active in-window (stale-open issues excluded).
    type Issue = { state: string; closed_at: string | null; pull_request?: unknown };
    let openIssuesInWindow = 0;
    let closedIssues = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await githubFetch<Issue[]>(
        ctx,
        `${base}/issues?state=all&since=${encodeURIComponent(since)}&per_page=100&page=${page}`,
      );
      for (const i of data) {
        if (i.pull_request != null) continue; // /issues intermingles PRs — exclude them.
        if (i.state === 'open') openIssuesInWindow += 1;
        else if (i.closed_at && i.closed_at >= since) closedIssues += 1;
      }
      if (data.length < 100) break;
      if (page === MAX_PAGES) truncated = true;
    }

    const languages = await githubFetch<Record<string, number>>(ctx, `${base}/languages`);

    if (truncated) {
      ctx.logger.info(
        { owner: input.owner, repo: input.repo, windowDays, maxPages: MAX_PAGES },
        'github.repo_activity hit page cap — counts may be undercounted',
      );
    }

    const summary = {
      windowDays,
      since,
      openPullRequestsInWindow,
      mergedPullRequests,
      recentCommits,
      openIssuesInWindow,
      closedIssues,
      contributors: contributors.size,
      languages,
      truncated,
    };
    return { ...summary, markdown: renderActivity(summary, `${input.owner}/${input.repo}`) };
  },
});
