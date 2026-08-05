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
 *
 * IT ALSO SAYS WHEN THERE IS NOTHING. This used to cut at a blended score of
 * 0.55 and return an empty `contextBlock` when nothing survived — which on a
 * corpus with no literal keyword overlap was every single query, because the
 * blend never reaches 0.55 on semantic matching alone (measured; see
 * relevance.ts). An empty string is also the worst possible way to say "no
 * material": it is indistinguishable from a failure, and a model handed one
 * fills the silence. The cut now lives in relevance.ts, on the axis that has a
 * meaning, and "nothing here" comes back as a sentence saying so.
 */

const SourceSchema = z.object({
  ref: z.number().int(),
  documentId: z.string(),
  documentTitle: z.string(),
  space: z.string(),
  spaceKind: z.enum(['global', 'personal']),
  bestScore: z.number(),
  /** 'strong' when at least one excerpt really answers the topic. */
  relevance: z.enum(['strong', 'weak']),
  /** "de hace 5 meses", "venció el 31 de enero de 2026" — empty when undated. */
  age: z.string().optional(),
  freshness: z.enum(['current', 'aging', 'old', 'expired', 'superseded']),
  excerpts: z.array(z.string()),
});

const ConflictSchema = z.object({
  note: z.string(),
  documentTitle: z.string(),
  otherDocumentTitle: z.string(),
  otherContent: z.string(),
  moreRecent: z.enum(['this', 'other']),
});

type SearchOutput = Awaited<ReturnType<typeof kbSearch.handler>>;
type Hit = SearchOutput['hits'][number];
type SearchConflict = NonNullable<SearchOutput['conflicts']>[number];

export const kbContext = registerTool({
  id: 'kb.context',
  description:
    "Build a grounded context briefing on a topic from the company's Brain Knowledge. Give it the topic (and optionally a few related angles) and it searches the brain from every angle, removes duplicates, groups the findings per source document, and returns a citation-ready block plus the structured sources. Use this before writing anything that should reflect what the company already knows — a proposal, a client email, a rate answer, an internal explanation — instead of running several separate searches. " +
    'CHECK `coverage` FIRST. "answered" means there is real material. "thin" means only tangential things came back: write with that caveat instead of dressing it up. "nothing" means Brain Knowledge has NO material on this topic — say so plainly and do not invent it; `contextBlock` will say the same thing so you can quote it. Each source carries its `age`, and anything marked expired or superseded must never be quoted as if it were still in force. ' +
    'If `conflicts` is non-empty, two documents of different dates disagree about the same point: name both, give their dates, and go with the more recent one unless you have a reason not to.',
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
    coverage: z.enum(['answered', 'thin', 'nothing', 'keyword-only']),
    sources: z.array(SourceSchema),
    conflicts: z.array(ConflictSchema).optional(),
    contextBlock: z.string(),
    chunksConsidered: z.number(),
    queriesRun: z.array(z.string()),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const queries = [input.topic, ...(input.angles ?? [])];

    // Dedupe by document+chunk, keeping the best score across queries.
    const byChunk = new Map<string, Hit>();
    // The best coverage any angle achieved: one angle finding real material is
    // enough for the briefing to be grounded, and reporting the worst angle
    // instead would tell the model there is nothing when there is.
    let best: 'answered' | 'thin' | 'nothing' | 'keyword-only' = 'nothing';
    const rank = { nothing: 0, 'keyword-only': 1, thin: 2, answered: 3 } as const;
    const conflicts = new Map<string, SearchConflict>();

    for (const q of queries) {
      const res = await runTool(kbSearch, { query: q, limit: input.perQueryLimit ?? 5 }, ctx);
      if (rank[res.coverage] > rank[best]) best = res.coverage;
      for (const h of res.hits as Hit[]) {
        const key = `${h.documentId}#${h.chunkIndex}`;
        const prev = byChunk.get(key);
        if (!prev || h.score > prev.score) byChunk.set(key, h);
      }
      for (const c of res.conflicts ?? []) {
        // The same disagreement will surface from several angles; it is one
        // disagreement and belongs in the briefing once.
        conflicts.set([c.documentTitle, c.otherDocumentTitle].sort().join('|'), c);
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
        strong: boolean;
        age?: string;
        freshness: Hit['freshness'];
        hits: Hit[];
      }
    >();
    for (const h of byChunk.values()) {
      const entry = byDoc.get(h.documentId) ?? {
        title: h.documentTitle,
        space: h.space,
        spaceKind: h.spaceKind,
        best: 0,
        strong: false,
        ...(h.age ? { age: h.age } : {}),
        freshness: h.freshness,
        hits: [] as Hit[],
      };
      entry.hits.push(h);
      entry.best = Math.max(entry.best, h.score);
      entry.strong = entry.strong || h.relevance === 'strong';
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
        relevance: entry.strong ? ('strong' as const) : ('weak' as const),
        ...(entry.age ? { age: entry.age } : {}),
        freshness: entry.freshness,
        excerpts: entry.hits
          .sort((a, b) => a.chunkIndex - b.chunkIndex)
          .map((h) => {
            const body =
              h.content.length > maxChars ? `${h.content.slice(0, maxChars)}…` : h.content;
            // A quote from a call is only worth as much as the ability to go
            // and check it. The chunk already names the speaker, so the offset
            // is all that is missing: "[12:34] Ana: we'll have it by Friday".
            return h.spokenAt ? `[${h.spokenAt}] ${body}` : body;
          }),
      }));

    const conflictList = [...conflicts.values()];

    const contextBlock =
      sources.length === 0
        ? // Never an empty string. An empty block is indistinguishable from a
          // failed call, and the model fills the silence — which is the exact
          // behaviour this tool now exists to stop.
          [
            `Brain Knowledge NO tiene material sobre: ${input.topic}`,
            '',
            best === 'keyword-only'
              ? 'Además, la búsqueda por significado no pudo correr (solo se buscaron palabras exactas), así que esto no prueba que no haya nada guardado. Dilo así.'
              : 'No hay nada guardado sobre esto. Dilo con esas palabras. No cites ni parafrasees ningún documento: no hay ninguno que respalde una respuesta sobre este tema.',
          ].join('\n')
        : [
            `Brain Knowledge context for: ${input.topic}`,
            ...(sources.every((s) => s.relevance === 'weak')
              ? [
                  '',
                  'AVISO: nada de lo de abajo responde directamente al tema; es material apenas relacionado. Úsalo como pista y dilo así.',
                ]
              : []),
            '',
            ...sources.map((s) =>
              [
                // The space is part of the citation because it changes what the
                // finding is worth: a company-wide space is what the company has
                // agreed on, a personal one is one person's working note. The
                // age is part of it for the same reason — a rate from a year ago
                // is a different claim from the same rate quoted last week.
                `[${s.ref}] ${s.documentTitle} — ${s.space}${s.spaceKind === 'personal' ? ' (your own notes)' : ''}` +
                  `${s.age ? ` · ${s.age}` : ''}${s.relevance === 'weak' ? ' · coincidencia débil' : ''}`,
                ...s.excerpts.map((e) => `    ${e.replace(/\s+/g, ' ')}`),
              ].join('\n'),
            ),
            ...(conflictList.length > 0
              ? ['', ...conflictList.map((c) => `⚠ CONFLICTO: ${c.note}`)]
              : []),
            '',
            'Cita estas fuentes como [1], [2], … cuando las uses. Todo lo que no esté arriba NO está en Brain Knowledge.',
          ].join('\n');

    return {
      topic: input.topic,
      coverage: best,
      sources,
      ...(conflictList.length > 0
        ? {
            conflicts: conflictList.map((c) => ({
              note: c.note,
              documentTitle: c.documentTitle,
              otherDocumentTitle: c.otherDocumentTitle,
              otherContent: c.otherContent,
              moreRecent: c.moreRecent,
            })),
          }
        : {}),
      contextBlock,
      chunksConsidered: byChunk.size,
      queriesRun: queries,
    };
  },
});
