import { IntegrationError } from '@zipdev/core';
import { z } from 'zod';
import { registerTool, runTool } from '../index';
import { webSearch } from '../web';

/**
 * Growth pilot, test 5 (job-post signal detection): sweep public job boards
 * for open remote roles matching Zipdev's ICP at US companies, dedupe against
 * the growth_signals table, and persist the new ones for review.
 *
 * A "signal" is a live job post that suggests the company is hiring for a
 * role Zipdev can fill (senior fullstack, QA, DevOps, ...). Sweeps are
 * composable: run from chat for a one-off, or from a weekly scheduled agent
 * job for the sustained 15-signals/week pilot target.
 */

const BOARD_SITES = [
  'boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'apply.workable.com',
  'jobs.smartrecruiters.com',
];

const SignalSchema = z.object({
  id: z.string(),
  company: z.string(),
  roleTitle: z.string(),
  url: z.string(),
  source: z.string(),
  summary: z.string().nullable(),
  status: z.string(),
});

export const growthFindSignals = registerTool({
  id: 'growth.find_signals',
  description:
    'Sweep public job boards (Greenhouse, Lever, Ashby, Workable, SmartRecruiters) for live job posts matching roles Zipdev fills (e.g. "senior fullstack engineer", "QA engineer") at companies hiring remote. Deduplicates against previously found signals (by posting URL) and stores the new ones with status "new" for review. Returns the new signals plus counts. Run weekly (via schedule.create) for the growth pilot. ' +
    'This DISCOVERS companies from a role — you do not name the company. If you already know which company you are asking about, apollo.company_job_postings lists everything that one company is advertising, including on career pages these five boards never see (it costs Apollo credits and stores nothing).',
  inputSchema: z.object({
    roles: z
      .array(z.string().min(2))
      .min(1)
      .max(5)
      .describe('Role queries to sweep, e.g. ["senior fullstack engineer", "senior QA engineer"]'),
    extraQualifiers: z
      .string()
      .default('remote')
      .describe('Extra search qualifiers appended to every query, e.g. "remote US"'),
    maxPerRole: z.number().int().min(1).max(10).default(8),
  }),
  outputSchema: z.object({
    newSignals: z.array(SignalSchema),
    newCount: z.number(),
    duplicateCount: z.number(),
    totalStored: z.number(),
  }),
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    if (!process.env.TAVILY_API_KEY) {
      throw new IntegrationError('TAVILY_API_KEY not configured — web search unavailable', 'web');
    }

    interface Candidate {
      company: string;
      roleTitle: string;
      url: string;
      source: string;
      summary: string;
    }
    const candidates = new Map<string, Candidate>();

    // One targeted query per (role x board) keeps results precise; Tavily
    // handles the ranking. Sequential to respect web.search's rate limit.
    for (const role of input.roles) {
      const siteFilter = BOARD_SITES.map((s) => `site:${s}`).join(' OR ');
      const query = `"${role}" ${input.extraQualifiers ?? 'remote'} (${siteFilter})`;
      const res = await runTool(
        webSearch,
        { query, maxResults: input.maxPerRole ?? 8, includeAnswer: false, searchDepth: 'basic' },
        ctx,
      );
      for (const r of res.results) {
        let host: string;
        try {
          host = new URL(r.url).hostname;
        } catch {
          continue;
        }
        const board = BOARD_SITES.find((s) => host === s || host.endsWith(`.${s}`));
        if (!board) continue;
        // Company slug is the first path segment on all supported boards.
        const slug = new URL(r.url).pathname.split('/').filter(Boolean)[0] ?? '';
        const company = slug
          .replace(/[-_]/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())
          .trim();
        if (!company) continue;
        candidates.set(r.url, {
          company,
          roleTitle: role,
          url: r.url,
          source: board,
          summary: (r.content ?? '').slice(0, 400),
        });
      }
    }

    // Dedupe against history and insert the new ones.
    const urls = [...candidates.keys()];
    const { data: existing } = urls.length
      ? await ctx.db.from('growth_signals').select('url').in('url', urls)
      : { data: [] as Array<{ url: string }> };
    const known = new Set((existing ?? []).map((e) => e.url as string));
    const fresh = [...candidates.values()].filter((c) => !known.has(c.url));

    const newSignals: Array<z.infer<typeof SignalSchema>> = [];
    for (const c of fresh) {
      const { data: row, error } = await ctx.db
        .from('growth_signals')
        .insert({
          company: c.company,
          role_title: c.roleTitle,
          url: c.url,
          source: c.source,
          summary: c.summary,
          region: 'US',
          found_by: ctx.userId,
        })
        .select('id, company, role_title, url, source, summary, status')
        .single();
      if (error || !row) continue; // unique-index race: another sweep won — fine
      newSignals.push({
        id: row.id as string,
        company: row.company as string,
        roleTitle: row.role_title as string,
        url: row.url as string,
        source: row.source as string,
        summary: (row.summary as string | null) ?? null,
        status: row.status as string,
      });
    }

    const { count } = await ctx.db
      .from('growth_signals')
      .select('id', { count: 'exact', head: true });

    return {
      newSignals,
      newCount: newSignals.length,
      duplicateCount: candidates.size - fresh.length,
      totalStored: count ?? 0,
    };
  },
});
