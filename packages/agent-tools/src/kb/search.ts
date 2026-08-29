import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { indexAdjustments, rerankByLearning } from '../learning/apply';
import { loadActiveAdjustments } from '../learning/store';
import { type Conflict, findConflicts } from './conflicts';
import { assessFreshness } from './freshness';
import { assessCoverage, calibrationFor, rateHit } from './relevance';
import { type SpaceHit, listVisibleSpaces, resolveSpaceByName, searchSpaces } from './spaces';
import { chunkOffsetMs, formatOffset } from './transcript-chunker';
import { widenExcerpts } from './widen';

/**
 * How many fragments a caller gets when it does not say. Named rather than
 * inline in the schema because zod's `.default()` leaves the field optional in
 * the INPUT type, so anything that has to state the limit as a number — the
 * retrieval observation below — needs the same value to fall back on, and two
 * copies of it would drift.
 */
const DEFAULT_LIMIT = 5;

const HitSchema = z.object({
  documentId: z.string().uuid(),
  documentTitle: z.string(),
  space: z.string(),
  spaceKind: z.enum(['global', 'shared', 'personal']),
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
    "Search the company's Brain Knowledge — client notes, playbooks, rates, past proposals, anything saved to it. ONE query in, matching excerpts out. Searches everything the asker has been given access to and nothing else. Pass `space` with a space name to look in just one. " +
    "`spaceKind` on each hit says what kind of place it came from, and it changes what you may DO with the finding: 'global' is company-wide knowledge, 'shared' is a space given to some teams or people — do not repeat it to somebody outside that circle — and 'personal' is the asker's own notebook, so say so instead of presenting it as company policy. " +
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
    limit: z.number().int().min(1).max(20).default(DEFAULT_LIMIT),
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
    // What this workspace has learned about its own material (migration 0083).
    // Started before anything is awaited so it overlaps with the space lookup
    // when there is one, and it is cached in process for a few seconds so a
    // burst of turns pays for it once. It never throws: an ordering preference
    // that fails to load costs the plain scores, which is exactly the retrieval
    // this tool had before the loop existed.
    const learning = loadActiveAdjustments(ctx.db, ctx.organizationId);

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

    // The one place learning touches an answer, and the fence around it lives
    // in learning/apply.ts: this may reorder fragments WITHIN a relevance band
    // and may do nothing else. The band is computed here, from the calibration
    // that is really in force for the model that produced these scores — the
    // same expression `assessCoverage` uses below — because a module that
    // guessed at the thresholds would be able to guess its way past them.
    //
    // Spread conditionally: with nothing learned, no reranker is passed at all,
    // and both the query and its result set are byte-identical to what they
    // were before this module existed.
    const index = indexAdjustments(await learning);
    const rerank = index.empty
      ? undefined
      : (hits: SpaceHit[]): SpaceHit[] => {
          const calibration = calibrationFor(
            hits.find((h) => h.embeddingModel)?.embeddingModel ?? null,
          );
          return rerankByLearning(hits, index, {
            key: (h) => ({ documentId: h.documentId, chunkIndex: h.chunkIndex }),
            band: (h) => rateHit(h, calibration, input.query) ?? 'dropped',
          });
        };

    const raw = await searchSpaces(ctx.db, {
      userId: ctx.userId,
      query: input.query,
      ...(spaceIds ? { spaceIds } : {}),
      limit: input.limit,
      ...(rerank ? { rerank } : {}),
      // This is the retrieval that answers somebody, so it is the one that
      // counts. Everything the Brain Knowledge page runs — its search box, its
      // memory bench — deliberately does not, so "fragments Cortex has never
      // used" keeps meaning what it says. See migration 0073.
      recordRetrieval: true,
      // El segundo lector (kb/reranker.ts). Se enciende AQUÍ y no en
      // `searchSpaces` porque ésta es la búsqueda que contesta a alguien: la
      // caja de búsqueda de la página de Brain Knowledge y su banco de memoria
      // miden la recuperación cruda a propósito y no deben pagar la llamada ni
      // ver un orden distinto del que produce el índice.
      secondReader: true,
      logger: ctx.logger,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onDegraded: (reason) => {
        degraded = reason;
        ctx.logger.warn({ reason }, 'kb.search fell back to keyword-only retrieval');
      },
    });

    const verdict = assessCoverage(raw, {
      query: input.query,
      degraded: Boolean(degraded),
      ...(spaceName ? { spaceName } : {}),
      // Which scale these cosines are on. The thresholds differ per embedding
      // model and a score judged against the wrong model's cuts is how a full
      // brain reports "no hay nada sobre eso" — see relevance.ts.
      embeddingModel: raw.find((h) => h.embeddingModel)?.embeddingModel ?? null,
    });

    // Hand the whole result set to whoever is watching this turn, BEFORE the
    // floor is applied below — the rows that are about to be discarded are the
    // ones worth keeping a record of, and this is the last moment they exist.
    // See ToolContext.onRetrieval for why it cannot be done anywhere else.
    // Never allowed to affect the search: an observer that throws is a bug in
    // the observer, not a failed retrieval.
    if (ctx.onRetrieval) {
      try {
        ctx.onRetrieval({
          query: input.query,
          limit: input.limit ?? DEFAULT_LIMIT,
          coverage: verdict.coverage,
          summary: verdict.summary,
          cuts: {
            modelId: verdict.calibration.modelId,
            strongMatch: verdict.calibration.strongMatch,
            weakFloor: verdict.calibration.weakFloor,
            railCeiling: verdict.calibration.railCeiling,
            measured: verdict.calibration.measured,
          },
          hits: raw.map((h) => ({
            chunkId: h.chunkId,
            documentId: h.documentId,
            documentTitle: h.documentTitle,
            spaceId: h.spaceId,
            spaceName: h.spaceName,
            spaceKind: h.spaceKind,
            chunkIndex: h.chunkIndex,
            content: h.content,
            cosine: h.semanticScore,
            keyword: h.keywordScore,
            blended: h.score,
            // The rating that was really applied, by the calibration that was
            // really in force — not re-judged later against whatever the
            // thresholds have become.
            verdict: rateHit(h, verdict.calibration, input.query) ?? 'dropped',
          })),
        });
      } catch {
        // Deliberately silent. Diagnostics never break an answer.
      }
    }

    if (!verdict.calibration.measured && !degraded) {
      ctx.logger.warn(
        { model: verdict.calibration.modelId },
        'kb.search is judging relevance with unmeasured thresholds — run the corpus and add the model to CALIBRATIONS in relevance.ts',
      );
    }

    const now = new Date();

    // Los bordes de los vecinos, pegados DESPUÉS del corte y del suelo: esto no
    // cambia qué se recupera ni cómo se puntúa, sólo evita entregar media
    // cláusula. Ver kb/widen.ts.
    const widened = await widenExcerpts(
      ctx.db,
      verdict.kept.map(({ hit }) => ({
        documentId: hit.documentId,
        chunkIndex: hit.chunkIndex,
        content: hit.content,
        metadata: hit.metadata,
      })),
    );

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
        content: widened.get(`${hit.documentId}#${hit.chunkIndex}`) ?? hit.content,
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
