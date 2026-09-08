import { IntegrationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool, runTool } from '../index';
import { webSearch } from '../web';
import { SignalRow, toSignal } from './signals';

const HIRING_BOARDS = [
  'boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'apply.workable.com',
  'jobs.smartrecruiters.com',
];

export type SearchPlan = {
  company: string | null;
  query: string;
  buyingSignal: string;
  roleTitle?: string;
};

export function buildSearchPlans(input: {
  mode?: 'commercial' | 'hiring';
  companies?: string[];
  offer?: string;
  idealClient?: string;
  industries?: string[];
  buyingSignals?: string[];
  regions?: string[];
  sources?: string[];
  roles?: string[];
  extraQualifiers?: string;
}): SearchPlan[] {
  const mode = input.mode ?? (input.roles?.length ? 'hiring' : 'commercial');
  if (mode === 'hiring') {
    const boards = input.sources?.length ? input.sources : HIRING_BOARDS;
    const scope = ` (${boards.map((source) => `site:${source}`).join(' OR ')})`;
    return (input.roles ?? []).map((role) => ({
      company: null,
      roleTitle: role,
      buyingSignal: `Contratación: ${role}`,
      query: `"${role}" ${input.extraQualifiers ?? 'remote'}${scope}`,
    }));
  }
  const scope = input.sources?.length
    ? ` (${input.sources.map((source) => `site:${source}`).join(' OR ')})`
    : '';
  const companies: Array<string | null> = input.companies?.length ? input.companies : [null];
  return companies.flatMap((company) =>
    (input.buyingSignals ?? []).map((signal) => ({
      company,
      buyingSignal: signal,
      query: [
        company ? `"${company}"` : null,
        `"${signal}"`,
        input.idealClient,
        input.industries?.join(' OR '),
        input.regions?.join(' OR '),
        input.extraQualifiers,
        scope,
      ]
        .filter(Boolean)
        .join(' '),
    })),
  );
}

const InputSchema = z
  .object({
    mode: z.enum(['commercial', 'hiring']).optional(),
    companies: z
      .array(z.string().min(2))
      .max(20)
      .optional()
      .describe('Optional named targets; broad result titles remain unverified candidate names'),
    offer: z.string().min(2).optional().describe('What this organization sells'),
    idealClient: z.string().min(2).optional().describe('Configurable ideal-client profile'),
    industries: z.array(z.string().min(2)).max(8).optional(),
    buyingSignals: z
      .array(z.string().min(2))
      .max(8)
      .optional()
      .describe('Events worth investigating, e.g. expansion, regulation, funding, contract expiry'),
    opportunityNeed: z
      .string()
      .min(2)
      .optional()
      .describe('Need the offer could address; a hypothesis pending review'),
    regions: z.array(z.string().min(2)).max(8).optional(),
    sources: z
      .array(z.string().min(3))
      .max(10)
      .optional()
      .describe('Optional domains; omit to search the open web'),
    roles: z
      .array(z.string().min(2))
      .min(1)
      .max(5)
      .optional()
      .describe('Legacy hiring-mode role queries'),
    extraQualifiers: z.string().optional(),
    maxPerQuery: z.number().int().min(1).max(10).default(5),
    maxPerRole: z.number().int().min(1).max(10).optional().describe('Legacy alias for maxPerQuery'),
  })
  .superRefine((input, ctx) => {
    const mode = input.mode ?? (input.roles?.length ? 'hiring' : 'commercial');
    if (mode === 'commercial') {
      for (const key of ['offer', 'idealClient', 'buyingSignals'] as const) {
        if (!input[key] || (Array.isArray(input[key]) && input[key].length === 0))
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `Required in commercial mode: ${key}`,
          });
      }
    } else if (!input.roles?.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roles'],
        message: 'Required in hiring mode',
      });
  });

export const growthFindSignals = registerTool({
  id: 'growth.find_signals',
  description:
    'Investigate buying signals in any industry and save public evidence for human review. Commercial mode requires offer, ideal client and buying signals. Company names are optional: broad discovery stores unverified candidate titles separately. Optional source domains narrow the search; otherwise it searches the open web. Split large requests into batches of at most 20 searches. Legacy hiring mode accepts roles. It never contacts anyone or sends a campaign.',
  inputSchema: InputSchema,
  outputSchema: z.object({
    newSignals: z.array(SignalRow),
    newCount: z.number(),
    duplicateCount: z.number(),
    totalStored: z.number(),
  }),
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    if (!process.env.TAVILY_API_KEY)
      throw new IntegrationError('TAVILY_API_KEY not configured — web search unavailable', 'web');
    const candidates = new Map<string, Record<string, unknown>>();
    const plans = buildSearchPlans(input);
    if (plans.length > 20)
      throw new Error('Divide la investigación en lotes de hasta 20 búsquedas.');
    for (const plan of plans) {
      const result = await runTool(
        webSearch,
        {
          query: plan.query,
          maxResults: input.maxPerRole ?? input.maxPerQuery ?? 5,
          includeAnswer: false,
          searchDepth: 'basic',
        },
        ctx,
      );
      for (const hit of result.results) {
        let parsed: URL;
        try {
          parsed = new URL(hit.url);
        } catch {
          continue;
        }
        let company = plan.company;
        if (!company && plan.roleTitle) {
          const board = HIRING_BOARDS.find(
            (host) => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`),
          );
          if (!board) continue;
          const slug = parsed.pathname.split('/').filter(Boolean)[0] ?? '';
          company = slug
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase())
            .trim();
        }
        const candidateName = company ? null : hit.title.slice(0, 200);
        const evidence = (hit.content ?? '').slice(0, 500);
        candidates.set(hit.url, {
          company: company || null,
          candidate_name: candidateName,
          role_title: plan.roleTitle ?? null,
          offer: input.offer ?? null,
          ideal_client: input.idealClient ?? null,
          industry: input.industries?.join(', ') ?? null,
          buying_signal: plan.buyingSignal,
          opportunity_need: input.opportunityNeed ?? null,
          evidence_excerpt: evidence,
          url: hit.url,
          source: parsed.hostname,
          summary: evidence,
          region: input.regions?.join(', ') ?? (plan.roleTitle ? 'US' : null),
          found_by: ctx.userId,
        });
      }
    }
    const urls = [...candidates.keys()];
    const { data: existing, error: existingError } = urls.length
      ? await ctx.db.from('growth_signals').select('url').in('url', urls)
      : { data: [] as Array<{ url: string }>, error: null };
    if (existingError)
      throw new Error('No se pudo comprobar cuáles oportunidades ya estaban guardadas.');
    const known = new Set((existing ?? []).map((row) => row.url as string));
    const fresh = [...candidates.entries()].filter(([url]) => !known.has(url));
    const newSignals: Array<z.infer<typeof SignalRow>> = [];
    let concurrentDuplicates = 0;
    for (const [, candidate] of fresh) {
      const { data, error } = await ctx.db
        .from('growth_signals')
        .insert(candidate)
        .select('*')
        .single();
      if (error) {
        if (error.code === '23505') {
          concurrentDuplicates += 1;
          continue;
        }
        throw new Error(`growth_signals insert failed: ${error.message}`);
      }
      if (!data) throw new Error('growth_signals insert returned no row');
      newSignals.push(toSignal(data));
    }
    const { count, error: countError } = await ctx.db
      .from('growth_signals')
      .select('id', { count: 'exact', head: true });
    if (countError || count == null)
      throw new Error(
        'La investigación terminó, pero no se pudo leer el total de oportunidades guardadas.',
      );
    return {
      newSignals,
      newCount: newSignals.length,
      duplicateCount: candidates.size - fresh.length + concurrentDuplicates,
      totalStored: count,
    };
  },
});
