import { IntegrationError } from '@zipdev/core';
import { z } from 'zod';
import { registerTool, runTool } from '../index';
import { webSearch } from '../web';

/**
 * Growth pilot, test 6 (contact identification): research the likely hiring
 * decision-maker for a signal via web search, and surface an email pattern
 * when one is publicly known. Everything is returned as EVIDENCE with sources
 * — the model (and Mikey) judge; the tool never fabricates a contact.
 */
export const growthIdentifyContact = registerTool({
  id: 'growth.identify_contact',
  description:
    'Research the likely hiring decision-maker at a company (for a growth signal): runs targeted web searches for engineering/talent leadership and the company\'s public email pattern. Returns raw evidence snippets with source URLs — synthesize a contact recommendation from them and mark it "found" (name+path seen publicly) or "inferred" (pattern-derived). Then record it with growth.update_signal.',
  inputSchema: z.object({
    company: z.string().min(2),
    roleTitle: z
      .string()
      .optional()
      .describe('The role being hired — steers who the right decision-maker is'),
  }),
  outputSchema: z.object({
    leadershipEvidence: z.array(
      z.object({ title: z.string(), url: z.string(), snippet: z.string() }),
    ),
    emailPatternEvidence: z.array(
      z.object({ title: z.string(), url: z.string(), snippet: z.string() }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    if (!process.env.TAVILY_API_KEY) {
      throw new IntegrationError('TAVILY_API_KEY not configured — web search unavailable', 'web');
    }

    const who = /qa|test/i.test(input.roleTitle ?? '')
      ? 'Head of QA OR VP Engineering OR Director of Engineering'
      : /recruit|talent/i.test(input.roleTitle ?? '')
        ? 'Head of Talent OR Director of Recruiting'
        : 'VP Engineering OR CTO OR Head of Engineering OR Director of Engineering';

    const [leadership, pattern] = [
      await runTool(
        webSearch,
        {
          query: `${input.company} (${who}) name`,
          maxResults: 6,
          includeAnswer: false,
          searchDepth: 'advanced',
        },
        ctx,
      ),
      await runTool(
        webSearch,
        {
          query: `${input.company} email format pattern first.last`,
          maxResults: 4,
          includeAnswer: false,
          searchDepth: 'basic',
        },
        ctx,
      ),
    ];

    const trim = (rs: typeof leadership.results) =>
      rs.map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? '').slice(0, 300) }));

    return {
      leadershipEvidence: trim(leadership.results),
      emailPatternEvidence: trim(pattern.results),
      guidance:
        'Pick the most senior person whose scope covers the open role, citing the evidence URL. Build the email from the documented pattern only if one appears above; label it "inferred". If no credible person or pattern appears, report "unknown" — do not guess. Record the result with growth.update_signal.',
    };
  },
});
