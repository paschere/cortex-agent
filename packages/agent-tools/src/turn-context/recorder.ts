/**
 * The recorder: it watches one turn being assembled and writes down what was
 * really handed over.
 *
 * ---------------------------------------------------------------------------
 * TWO PROPERTIES, AND EVERYTHING HERE IS ONE OR THE OTHER
 * ---------------------------------------------------------------------------
 *
 * 1. IT RECORDS, IT NEVER RE-DERIVES. Every value on a captured turn is handed
 *    to this object BY THE CODE THAT USED IT, at the moment it used it. The
 *    recorder never searches, never ranks, never embeds and never reads a
 *    threshold. It cannot: it has no database handle until `save`, and by then
 *    the turn is over. That is deliberate — an object that could look something
 *    up is an object that will eventually look something up instead of being
 *    told, and the first time that happens the surface starts lying on exactly
 *    the turns it exists to explain.
 *
 *    The near-miss fragments are the sharpest case. They never reach the chat
 *    route at all — `kb.search` drops everything below the floor before it
 *    returns — so the only honest way to have them is to be handed them from
 *    inside the retrieval that ran. That is `ToolContext.onRetrieval`, and it
 *    is why that hook exists rather than a second search here.
 *
 * 2. IT IS NEVER ON THE CRITICAL PATH. Accumulating is pure assignment: a few
 *    object literals and a `.length`, microseconds, no I/O. The single write
 *    happens in `save`, which the chat route calls from `onFinish` — after the
 *    last token has been streamed to the person. If it is slow, nobody is
 *    waiting. If it throws, it is swallowed: a diagnostics row is never worth
 *    a turn, and `save` returns void for exactly that reason — there is no
 *    result a caller could sensibly branch on.
 */

import { createHash } from 'node:crypto';
import type { Logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { RetrievalObservation } from '../types';
import {
  EXCERPT_CHARS,
  MAX_FRAGMENTS,
  MAX_OFFERED_TOOLS,
  MEMORY_CHARS,
  excerpt,
  retentionFrom,
} from './policy';
import type {
  CapturedFamily,
  CapturedFragment,
  CapturedMemory,
  CapturedRetrieval,
  CapturedToolOffer,
  ContextPart,
  ContextPartKey,
  TurnContextCapture,
} from './types';
import { weighParts } from './weigh';

/**
 * The fingerprint of an agent's prompt.
 *
 * Exported because two places must produce it identically or the comparison is
 * meaningless: the recorder, stamping the prompt that was sent, and the page,
 * fingerprinting the prompt as it stands now to work out whether it moved. One
 * function, so they cannot disagree.
 */
export function promptDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * How a fragment is named when matching "what came back" against "what was
 * pasted in".
 *
 * Document plus fragment index, and not the chunk id, because `kb.search` does
 * not return chunk ids — 0066 deliberately dropped them from the tool output —
 * so the block-building side of the chat route never has one to hand back. The
 * pair identifies a fragment exactly as well, and it is the identity that
 * survives on both sides of the call.
 */
export function fragmentKey(documentId: string, chunkIndex: number): string {
  return `${documentId}:${chunkIndex}`;
}

/** No retrieval happened. Still a fact about the turn, and still worth showing. */
function noRetrieval(skipped: string, limit: number): CapturedRetrieval {
  return {
    ran: false,
    skipped,
    query: '',
    coverage: 'nothing',
    summary: '',
    cuts: { modelId: '', strongMatch: 0, weakFloor: 0, railCeiling: 1, measured: false },
    limit,
    fragments: [],
  };
}

export interface TurnContextRecorderInit {
  organizationId: string;
  conversationId: string;
  userId: string;
  agentId: string;
  model: string;
  logger?: Logger;
}

export class TurnContextRecorder {
  private readonly init: TurnContextRecorderInit;
  private readonly texts: Array<{ key: ContextPartKey; text: string }> = [];
  private instructions = { chars: 0, digest: '' };
  private memories: CapturedMemory[] = [];
  private retrieval: CapturedRetrieval = noRetrieval('No se buscó en Brain Knowledge.', 0);
  private tools: CapturedToolOffer = {
    reason: 'below-threshold',
    candidates: 0,
    offered: [],
    families: [],
  };
  private overridden = false;

  constructor(init: TurnContextRecorderInit) {
    this.init = init;
  }

  /**
   * Weigh a part of the prompt. Called with the STRING THAT WAS SENT, never
   * with a description of it — the whole value of the weight column is that it
   * was measured on the real thing.
   */
  part(key: ContextPartKey, text: string): void {
    if (!text) return;
    this.texts.push({ key, text });
  }

  /** The agent's own prompt: length and fingerprint, never a copy. See types.ts. */
  basePrompt(text: string): void {
    this.instructions = { chars: text.length, digest: promptDigest(text) };
  }

  memory(entries: Array<{ id: string; text: string }>): void {
    this.memories = entries.map((m) => ({ id: m.id, text: excerpt(m.text, MEMORY_CHARS) }));
  }

  /** Why retrieval did not run. A skipped turn is a finding, not a blank. */
  retrievalSkipped(why: string, limit: number): void {
    this.retrieval = noRetrieval(why, limit);
  }

  /**
   * The real retrieval, straight from the search that ran, losers included.
   *
   * `prepended` is the set of fragments that actually made it into the prompt,
   * keyed by `fragmentKey`. It is supplied by the caller that BUILT THE BLOCK
   * rather than inferred from the verdicts here, and that distinction is the
   * whole reliability of the column: "cleared the floor" and "was pasted above
   * the question" are different facts, they come apart whenever the limit bites
   * or the block is assembled differently, and only the caller knows the second
   * one. Deriving it here from the scores would be a reconstruction — the one
   * thing this module may not do.
   */
  retrieved(observation: RetrievalObservation, prepended: ReadonlySet<string>): void {
    const fragments: CapturedFragment[] = observation.hits.slice(0, MAX_FRAGMENTS).map((h) => ({
      chunkId: h.chunkId,
      documentId: h.documentId,
      documentTitle: h.documentTitle,
      spaceId: h.spaceId,
      spaceName: h.spaceName,
      spaceKind: h.spaceKind,
      chunkIndex: h.chunkIndex,
      cosine: h.cosine,
      keyword: h.keyword,
      blended: h.blended,
      verdict: h.verdict,
      prepended: prepended.has(fragmentKey(h.documentId, h.chunkIndex)),
      excerpt: excerpt(h.content, EXCERPT_CHARS),
    }));

    this.retrieval = {
      ran: true,
      skipped: null,
      query: observation.query,
      coverage: observation.coverage,
      summary: observation.summary,
      cuts: observation.cuts,
      limit: observation.limit,
      fragments,
    };
  }

  /**
   * What the model was offered and how the ranker got there.
   *
   * `offered` is read off the declarations that were built, so it is the list
   * the model saw and not the list the selector returned — those are the same
   * thing today and there is no reason to trust that they stay so.
   */
  toolOffer(offer: CapturedToolOffer): void {
    this.tools = {
      ...offer,
      offered: offer.offered.slice(0, MAX_OFFERED_TOOLS),
    };
  }

  adjusted(on: boolean): void {
    this.overridden = on;
  }

  /** What has been recorded so far. Used by the tests, and by `save`. */
  capture(usage?: { promptTokens?: number; completionTokens?: number }): TurnContextCapture {
    const parts: ContextPart[] = weighParts(this.texts);
    return {
      model: this.init.model,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      parts,
      instructions: this.instructions,
      memories: this.memories,
      retrieval: this.retrieval,
      tools: this.tools,
      overridden: this.overridden,
    };
  }

  /**
   * Write the row. Called after the answer has been delivered, and awaited by
   * nothing the person is waiting on.
   *
   * Swallows everything. A workspace whose migrations lag by one, a lock, a
   * column that does not exist yet: none of those may turn into a visible
   * failure on a turn that already succeeded.
   */
  async save(
    db: SupabaseClient,
    opts: {
      messageId: string | null;
      usage?: { promptTokens?: number; completionTokens?: number };
    },
  ): Promise<void> {
    try {
      const capture = this.capture(opts.usage);
      const { detailUntil, purgeAt } = retentionFrom();
      const { error } = await db.from('turn_contexts').insert({
        conversation_id: this.init.conversationId,
        message_id: opts.messageId,
        user_id: this.init.userId,
        agent_id: this.init.agentId,
        model: capture.model,
        prompt_tokens: capture.promptTokens,
        completion_tokens: capture.completionTokens,
        parts: capture.parts,
        instructions: capture.instructions,
        memories: capture.memories,
        retrieval: capture.retrieval,
        tools: capture.tools,
        overridden: capture.overridden,
        detail_until: detailUntil,
        purge_at: purgeAt,
      });
      if (error) {
        this.init.logger?.warn({ err: error }, 'turn_contexts insert failed');
      }
    } catch (err) {
      this.init.logger?.warn({ err }, 'turn_contexts capture threw');
    }
  }
}

/**
 * Turn a selection result into the family ledger the page draws.
 *
 * Pure, and separate from the recorder, because it is the one piece of this
 * module with a judgement in it — deciding what to call a family that was not
 * offered — and that judgement should be testable without constructing a turn.
 */
export function familiesFrom(input: {
  scores: ReadonlyArray<{ family: string; score: number }>;
  alwaysFamilies: readonly string[];
  selected: readonly string[];
  unranked: readonly string[];
  muted: readonly string[];
}): CapturedFamily[] {
  const selected = new Set(input.selected);
  const unranked = new Set(input.unranked);
  const muted = new Set(input.muted);
  const scored = new Map(input.scores.map((s) => [s.family, s.score]));
  const out: CapturedFamily[] = [];

  for (const family of input.alwaysFamilies) {
    out.push({
      family,
      score: null,
      offered: !muted.has(family),
      reason: muted.has(family) ? 'muted' : 'always',
    });
  }
  for (const family of unranked) {
    out.push({
      family,
      score: null,
      offered: !muted.has(family),
      reason: muted.has(family) ? 'muted' : 'unindexed',
    });
  }
  for (const [family, score] of scored) {
    if (unranked.has(family)) continue;
    const offered = selected.has(family) && !muted.has(family);
    out.push({
      family,
      score,
      offered,
      reason: muted.has(family) ? 'muted' : selected.has(family) ? 'ranked' : 'below-cut',
    });
  }

  // Best score first, then the unscored ones. A reader scanning this column is
  // looking for "what nearly made it", which is the top of the losing half.
  return out.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}
