import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { type Conflict, findConflicts } from './conflicts';
import { assessFreshness } from './freshness';
import { assessCoverage } from './relevance';
import { listVisibleSpaces, resolveSpaceByName, searchSpaces } from './spaces';
import { chunkOffsetMs, formatOffset } from './transcript-chunker';

const HitSchema = z.object({
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  space: z.string(),
  spaceKind: z.enum(['global', 'personal']),
  chunkIndex: z.number().int(),
  content: z.string(),
  score: z.number(),
  /**
   * 'strong' — this passage answers the question, quote it.
   * 'weak'   — related, may well not answer it. Say so when you use it.
   * Anything below the floor never reaches this list at all; see relevance.ts.
   */
  relevance: z.enum(['strong', 'weak']),
  /**
   * How old the source is, in Spanish, ready to say out loud: "de hace 5
   * meses", "venció el 31 de enero de 2026", "reemplazado por «…»". Present
   * whenever the document has a date, which is nearly always.
   */
  age: z.string().optional(),
  /** The machine-readable half of `age`, for a caller that wants to branch. */
  freshness: z.enum(['current', 'aging', 'old', 'expired', 'superseded']),
  /**
   * Present only on hits from a recording: `mm:ss` into it, where this was
   * said. It is the difference between "it is somewhere in that call" and a
   * quote the person can go and listen to. Who said it is already the first
   * thing in `content`.
   */
  spokenAt: z.string().optional(),
});

const ConflictSchema = z.object({
  note: z.string(),
  documentTitle: z.string(),
  otherDocumentTitle: z.string(),
  otherSpace: z.string(),
  otherContent: z.string(),
  otherDatedAt: z.string().nullable(),
  moreRecent: z.enum(['this', 'other']),
  similarity: z.number(),
});

function toConflictOutput(c: Conflict) {
  return {
    note: c.note,
    documentTitle: c.hit.documentTitle,
    otherDocumentTitle: c.rival.documentTitle,
    otherSpace: c.rival.spaceName,
    otherContent: c.rival.content,
    otherDatedAt: c.rival.datedAt,
    moreRecent: c.newer === 'hit' ? ('this' as const) : ('other' as const),
    similarity: c.similarity,
  };
}

/**
 * The tool no longer takes "which scopes to search". It used to, and that was
 * the bug: the model chose the breadth of its own retrieval, and one of the
 * choices ('conversation') reached across users. What is searchable is now a
 * fact about who is asking, decided in Postgres from `ctx.userId`. The only
 * thing the caller can express is a NARROWING, by name, to a space it can
 * already see.
 *
 * What it now also returns is an opinion about its own results. `coverage` says
 * whether anything actually answered the question, and hits below the relevance
 * floor are dropped rather than handed over as the least-bad rows in an index —
 * because a model given a list of chunks reads it as evidence, and a list of
 * near-misses is exactly how a confident wrong answer gets made.
 */
export const kbSearch = registerTool({
  id: 'kb.search',
  description:
    "Search the company's Brain Knowledge — client notes, playbooks, rates, past proposals, anything saved to it. ONE query in, matching excerpts out. Searches every company-wide space plus the asker's own personal spaces, and nobody else's. Pass `space` with a space name to look in just one. Each result says which space it came from, so you can tell the person whether what you found is company knowledge or their own note. " +
    'READ `coverage` BEFORE YOU ANSWER. "answered" means something in there really does answer the question. "thin" means only tangential material came back — say that it is tangential instead of presenting it as the answer. "nothing" means Brain Knowledge holds NOTHING on the topic: say so plainly, in those words, because that is a real and useful answer and much better than stretching an unrelated excerpt to fit. "keyword-only" means the semantic search was down and only exact words were matched, so absence proves nothing. The `summary` field is written for you to act on; each hit also carries `relevance` ("strong" or "weak") and `age`. ' +
    'Anything in `conflicts` means two documents of different dates say different things about the same point — resolve it out loud, name the dates, and prefer the more recent one unless there is a reason not to. Never quote something marked expired or superseded as if it were current. ' +
    'Use this to look one specific thing up. When you are about to WRITE something that should reflect what the company knows — a proposal, a client email, a rate answer — use kb.context instead: it runs several angles at once and hands back grouped, citable sources.',
  inputSchema: z.object({
    query: z.string().min(1),
    space: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Name of a single space to search in, e.g. "Rates" — omit to search everything'),
    limit: z.number().int().min(1).max(20).default(5),
  }),
  outputSchema: z.object({
    /** What the brain turned out to know about this. See the description. */
    coverage: z.enum(['answered', 'thin', 'nothing', 'keyword-only']),
    /** The verdict in Spanish, written to be acted on rather than parsed. */
    summary: z.string(),
    hits: z.array(HitSchema),
    conflicts: z.array(ConflictSchema).optional(),
    /**
     * Present only when retrieval ran degraded (keyword-only). It is in the
     * output rather than only in the logs because "I found nothing" and "I could
     * only match on words" are different answers, and the model is the one
     * talking to the person.
     */
    note: z.string().optional(),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    let spaceIds: string[] | undefined;
    let spaceName: string | undefined;

    if (input.space) {
      const space = await resolveSpaceByName(ctx.db, ctx.userId, input.space);
      if (!space) {
        const names = (await listVisibleSpaces(ctx.db, ctx.userId)).map((s) => s.name);
        throw new ValidationError(
          names.length > 0
            ? `There is no space called "${input.space}". You can search: ${names.join(', ')}.`
            : `There is no space called "${input.space}", and nothing has been shared with you yet.`,
        );
      }
      spaceIds = [space.id];
      spaceName = space.name;
    }

    // The surface's ceiling, when it set one. Intersected rather than replaced,
    // so a model asking for a space outside the ceiling gets nothing instead of
    // getting it. `[]` is a real value here — "no space at all" — and falling
    // back to `spaceIds` on an empty array would turn the tightest possible
    // restriction into none, which is the one way this can fail dangerously.
    // See ToolContext.kbSpaceIds.
    if (ctx.kbSpaceIds) {
      spaceIds = spaceIds
        ? spaceIds.filter((id) => ctx.kbSpaceIds?.includes(id))
        : [...ctx.kbSpaceIds];
    }

    let degraded: string | undefined;
    const raw = await searchSpaces(ctx.db, {
      userId: ctx.userId,
      query: input.query,
      ...(spaceIds ? { spaceIds } : {}),
      limit: input.limit,
      onDegraded: (reason) => {
        degraded = reason;
        ctx.logger.warn({ reason }, 'kb.search fell back to keyword-only retrieval');
      },
    });

    const verdict = assessCoverage(raw, {
      query: input.query,
      degraded: Boolean(degraded),
      ...(spaceName ? { spaceName } : {}),
    });

    const now = new Date();
    const hits = verdict.kept.map(({ hit, relevance }) => {
      const offsetMs = chunkOffsetMs(hit.metadata);
      const spokenAt = offsetMs === null ? undefined : formatOffset(offsetMs);
      const freshness = assessFreshness({
        datedAt: hit.datedAt,
        validUntil: hit.validUntil,
        supersededByTitle: hit.supersededByTitle,
        now,
      });
      return {
        documentId: hit.documentId,
        documentTitle: hit.documentTitle,
        space: hit.spaceName,
        spaceKind: hit.spaceKind,
        chunkIndex: hit.chunkIndex,
        content: hit.content,
        score: hit.score,
        relevance,
        ...(freshness.label ? { age: freshness.label } : {}),
        freshness: freshness.status,
        ...(spokenAt ? { spokenAt } : {}),
      };
    });

    // Only what is worth defending gets a conflict lookup. A weak hit that the
    // model is already being told to treat as tangential does not need a second
    // opinion, and one probe per strong hit keeps this cheaper than the
    // embedding round-trip the search has already paid for.
    const strong = verdict.kept.filter((k) => k.relevance === 'strong').map((k) => k.hit);
    const conflicts =
      strong.length === 0
        ? []
        : await findConflicts(
            ctx.db,
            {
              userId: ctx.userId,
              hits: strong.map((h) => ({
                chunkId: h.chunkId,
                documentId: h.documentId,
                documentTitle: h.documentTitle,
                chunkIndex: h.chunkIndex,
                datedAt: h.datedAt,
                content: h.content,
              })),
              now,
            },
            (reason) => ctx.logger.warn({ reason }, 'kb.search could not check for conflicts'),
          );

    return {
      coverage: verdict.coverage,
      summary: verdict.summary,
      ...(degraded ? { note: degraded } : {}),
      hits,
      ...(conflicts.length > 0 ? { conflicts: conflicts.map(toConflictOutput) } : {}),
    };
  },
});
