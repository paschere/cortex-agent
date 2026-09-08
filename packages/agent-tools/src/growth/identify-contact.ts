import { IntegrationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool, runTool } from '../index';
import { webSearch } from '../web';

/**
 * Research a likely commercial decision-maker via public evidence.
 * when one is publicly known. Everything is returned as EVIDENCE with sources
 * — the model (and Mikey) judge; the tool never fabricates a contact.
 */
export const growthIdentifyContact = registerTool({
  id: 'growth.identify_contact',
  description:
    'Research a likely commercial decision-maker at a named company. The configurable offer, need and buyer remit determine which leadership roles to investigate. Only a contact path seen directly in evidence is "found"; a pattern-derived address is "inferred". Then record it with growth.update_signal. ' +
    'Public web evidence is the only source here: there is no bought contact database behind it, so an email address is almost always "inferred" from the company pattern rather than seen. Say which it is when you hand it over.',
  inputSchema: z.object({
    company: z.string().min(2),
    offer: z.string().optional(),
    opportunityNeed: z.string().optional(),
    buyerRemit: z
      .string()
      .optional()
      .describe('Function that likely owns the need, e.g. Operations, Finance, Commercial, Talent'),
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

    const commercialWho =
      input.buyerRemit?.trim() || 'CEO OR COO OR VP Sales OR Director of Operations';
    const who = /qa|test/i.test(input.roleTitle ?? '')
      ? 'Head of QA OR VP Engineering OR Director of Engineering'
      : /recruit|talent/i.test(input.roleTitle ?? '')
        ? 'Head of Talent OR Director of Recruiting'
        : input.roleTitle
          ? 'VP Engineering OR CTO OR Head of Engineering OR Director of Engineering'
          : commercialWho;

    const [leadership, pattern] = [
      await runTool(
        webSearch,
        {
          query: `${input.company} (${who}) name ${input.opportunityNeed ?? input.offer ?? ''}`,
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
        'Pick the person whose documented remit covers the opportunity need and cite the evidence URL. Mark a path "found" only if that exact path appears in public evidence. A pattern-built email is "inferred". If evidence is insufficient, report "unknown"; do not guess. Record the result with growth.update_signal.',
    };
  },
});
