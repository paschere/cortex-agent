import { z } from 'zod';
import { registerTool, runTool } from '../index';
import { kbSearch } from './search';

/**
 * kb.context — one call that turns a topic into a briefing.
 *
 * kb.search returns raw chunks for one query; a model working on a real task
 * (a proposal, a client call, a pricing question) usually needs several angles
 * and then has to stitch them together itself. This tool runs the retrieval
 * fan-out server-side: the main topic plus optional related angles, deduped by
 * chunk, grouped per source document, and rendered as a ready-to-use context
 * block with numbered citations. Fewer round-trips, less context burned, and
 * the citations stay attached to what was actually retrieved.
 */

const SourceSchema = z.object({
  ref: z.number().int(),
  documentId: z.string(),
  documentTitle: z.string(),
  space: z.string(),
  spaceKind: z.enum(['global', 'personal']),
  bestScore: z.number(),
  excerpts: z.array(z.string()),
});

const MIN_SCORE = 0.55;

export const kbContext = registerTool({
  id: 'kb.context',
  description:
    "Build a grounded context briefing on a topic from the company's Knowledge Base. Give it the topic (and optionally a few related angles) and it searches the brain from every angle, removes duplicates, groups the findings per source document, and returns a citation-ready block plus the structured sources. Use this before writing anything that should reflect what the company already knows — a proposal, a client email, a rate answer, an internal explanation — instead of running several separate searches. If it returns nothing, say plainly that the Knowledge Base has no material on the topic rather than inventing an answer.",
  inputSchema: z.object({
    topic: z.string().min(3).max(400).describe('The subject you need context about'),
    angles: z
      .array(z.string().min(3).max(200))
      .max(4)
      .default([])
      .describe(
        'Optional related sub-questions to broaden retrieval, e.g. ["pricing", "past objections"]',
      ),
    perQueryLimit: z.number().int().min(1).max(10).default(5),
    maxExcerptChars: z.number().int().min(200).max(2000).default(700),
  }),
  outputSchema: z.object({
    topic: z.string(),
    sources: z.array(SourceSchema),
    contextBlock: z.string(),
    chunksConsidered: z.number(),
    queriesRun: z.array(z.string()),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const queries = [input.topic, ...(input.angles ?? [])];

    interface Hit {
      documentId: string;
      documentTitle: string;
      space: string;
      spaceKind: 'global' | 'personal';
      chunkIndex: number;
      content: string;
      score: number;
    }
    // Dedupe by document+chunk, keeping the best score across queries.
    const byChunk = new Map<string, Hit>();
    for (const q of queries) {
      const res = await runTool(kbSearch, { query: q, limit: input.perQueryLimit ?? 5 }, ctx);
      for (const h of res.hits as Hit[]) {
        if (h.score < MIN_SCORE) continue;
        const key = `${h.documentId}#${h.chunkIndex}`;
        const prev = byChunk.get(key);
        if (!prev || h.score > prev.score) byChunk.set(key, h);
      }
    }

    // Group per document, best-scoring document first.
    const byDoc = new Map<
      string,
      {
        title: string;
        space: string;
        spaceKind: 'global' | 'personal';
        best: number;
        hits: Hit[];
      }
    >();
    for (const h of byChunk.values()) {
      const entry = byDoc.get(h.documentId) ?? {
        title: h.documentTitle,
        space: h.space,
        spaceKind: h.spaceKind,
        best: 0,
        hits: [],
      };
      entry.hits.push(h);
      entry.best = Math.max(entry.best, h.score);
      byDoc.set(h.documentId, entry);
    }

    const maxChars = input.maxExcerptChars ?? 700;
    const sources = [...byDoc.entries()]
      .sort((a, b) => b[1].best - a[1].best)
      .map(([documentId, entry], i) => ({
        ref: i + 1,
        documentId,
        documentTitle: entry.title,
        space: entry.space,
        spaceKind: entry.spaceKind,
        bestScore: Number(entry.best.toFixed(3)),
        excerpts: entry.hits
          .sort((a, b) => a.chunkIndex - b.chunkIndex)
          .map((h) =>
            h.content.length > maxChars ? `${h.content.slice(0, maxChars)}…` : h.content,
          ),
      }));

    const contextBlock =
      sources.length === 0
        ? ''
        : [
            `Knowledge Base context for: ${input.topic}`,
            '',
            ...sources.map((s) =>
              [
                // The space is part of the citation because it changes what the
                // finding is worth: a company-wide space is what the company has
                // agreed on, a personal one is one person's working note.
                `[${s.ref}] ${s.documentTitle} — ${s.space}${s.spaceKind === 'personal' ? ' (your own notes)' : ''}`,
                ...s.excerpts.map((e) => `    ${e.replace(/\s+/g, ' ')}`),
              ].join('\n'),
            ),
            '',
            'Cite these as [1], [2], … when you use them. Anything not covered above is NOT in the Knowledge Base.',
          ].join('\n');

    return {
      topic: input.topic,
      sources,
      contextBlock,
      chunksConsidered: byChunk.size,
      queriesRun: queries,
    };
  },
});
