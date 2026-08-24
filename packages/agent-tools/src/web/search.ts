import { IntegrationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';

export const webSearch = registerTool({
  id: 'web.search',
  description:
    'Search the web with Tavily. Use for anything that must be true TODAY or that is not in the company brain: TRM and other official rates, the DIAN, news, a company, a person, a page you do not have. Returns an optional synthesized answer plus titles, URLs, and snippets. For recent press specifically, prefer web.news. For prospects, company news, funding, and tech stacks, this is also the tool.',
  inputSchema: z.object({
    query: z.string().min(1),
    searchDepth: z.enum(['basic', 'advanced']).default('basic'),
    maxResults: z.number().int().min(1).max(10).default(5),
    includeAnswer: z.boolean().default(true),
  }),
  outputSchema: z.object({
    answer: z.string().nullable(),
    results: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        content: z.string(),
        score: z.number().nullable(),
      }),
    ),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) throw new IntegrationError('TAVILY_API_KEY not configured', 'web');

    type TavilyResult = { title?: string; url?: string; content?: string; score?: number };
    type TavilyResponse = { answer?: string; results?: TavilyResult[] };

    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: input.query,
        search_depth: input.searchDepth,
        max_results: input.maxResults,
        include_answer: input.includeAnswer,
      }),
      signal: ctx.signal,
    });
    if (!r.ok) throw new IntegrationError(`Tavily ${r.status}: ${await r.text()}`, 'web');

    const data = (await r.json()) as TavilyResponse;
    return {
      answer: data.answer ?? null,
      results: (data.results ?? []).map((res) => ({
        title: res.title ?? '',
        url: res.url ?? '',
        content: res.content ?? '',
        score: res.score ?? null,
      })),
    };
  },
});
