import 'server-only';
import { fragmentKey, heaviest, loadTurnContexts, loadTurnLatencies, shareOf } from '@cortex/agent-tools';
import type { ReadableTurnContext, StoredTurnLatency } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FragmentView, LatencyView, PartKey, TurnView } from '../_components/context/types';

/**
 * Turning a stored capture into what the page draws.
 *
 * THE ONE RULE. Nothing here computes a score, a verdict or a threshold. Every
 * number is copied out of the row exactly as it was written on the day of the
 * turn. The only things this file derives are presentation arithmetic — a
 * share of a total, which part is the biggest, how many fragments were
 * prepended — all of them functions of stored values and none of them capable
 * of disagreeing with what happened.
 *
 * In particular the relevance cuts are NOT read from `relevance.ts`. They come
 * off the row. Those thresholds have been recalibrated twice, and drawing an
 * old turn's fragments against today's cuts would put the bar in the wrong
 * place on exactly the turns somebody opened this page to understand.
 */

/** The agent prompt as it is now, so an old turn can say whether it moved. */
export interface PromptFingerprint {
  digest: string;
}

function toFragment(f: ReadableTurnContext['retrieval']['fragments'][number]): FragmentView {
  return {
    key: fragmentKey(f.documentId, f.chunkIndex),
    documentId: f.documentId,
    documentTitle: f.documentTitle,
    spaceName: f.spaceName,
    spaceKind: f.spaceKind,
    chunkIndex: f.chunkIndex,
    cosine: f.cosine,
    keyword: f.keyword,
    verdict: f.verdict,
    prepended: f.prepended,
    excerpt: f.excerpt,
    withheld: f.withheld,
  };
}

/**
 * The timing of a turn, copied off its row.
 *
 * The cache is summarised to two numbers here rather than shipped whole: the
 * page answers "did the prefix get reused" and not "what did each of the four
 * round-trips do", and the per-step detail belongs to the aggregate report, not
 * to one turn's panel.
 */
function toLatency(row: StoredTurnLatency): LatencyView {
  return {
    firstVisibleMs: row.firstVisibleMs,
    firstAnswerMs: row.firstAnswerMs,
    totalMs: row.totalMs,
    preludeMs: row.preludeMs,
    stages: row.stages.map((s) => ({ stage: s.stage as string, at: s.at, ms: s.ms })),
    steps: row.steps,
    toolCalls: row.toolCalls,
    toolMs: row.toolMs,
    cacheReadSteps: row.cache.filter((s) => s.read > 0).length,
    cacheTokensRead: row.cache.reduce((sum, s) => sum + s.read, 0),
  };
}

function toTurn(
  row: ReadableTurnContext,
  livePromptDigest: string | null,
  latency: LatencyView | null,
): TurnView {
  const parts = row.parts.map((p) => ({
    key: p.key as PartKey,
    chars: p.chars,
    tokens: p.tokens,
    share: shareOf(p, row.parts),
  }));

  const fragments = row.retrieval.fragments.map(toFragment);

  return {
    id: row.id,
    messageId: row.messageId,
    createdAt: row.createdAt,
    model: row.model,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    parts,
    heaviest: (heaviest(row.parts)?.key as PartKey | undefined) ?? null,
    totalChars: row.parts.reduce((sum, p) => sum + p.chars, 0),
    retrieval: {
      ran: row.retrieval.ran,
      skipped: row.retrieval.skipped,
      query: row.retrieval.query,
      coverage: row.retrieval.coverage,
      summary: row.retrieval.summary,
      cuts: row.retrieval.cuts,
      limit: row.retrieval.limit,
      fragments,
      prependedCount: fragments.filter((f) => f.prepended).length,
      droppedCount: fragments.filter((f) => f.verdict === 'dropped').length,
    },
    tools: row.tools,
    memories: row.memories,
    instructions: {
      chars: row.instructions.chars,
      // Null rather than false when there is nothing to compare against: "we
      // cannot tell" and "it changed" lead to different sentences, and the
      // panel says the honest one.
      unchanged:
        livePromptDigest === null || !row.instructions.digest
          ? null
          : livePromptDigest === row.instructions.digest,
    },
    latency,
    overridden: row.overridden,
    redacted: row.redacted,
  };
}

/**
 * Every captured turn of one conversation, keyed by the assistant message it
 * produced, plus the ones whose message was lost.
 *
 * The caller has already decided this viewer may read this conversation.
 * `loadTurnContexts` decides, separately and for every fragment, whether they
 * may read the text — see its header for why an org admin does not get a
 * colleague's personal spaces just because they can open the transcript.
 */
export async function loadTurnViews(
  db: SupabaseClient,
  opts: { conversationId: string; viewerId: string; livePromptDigest: string | null },
): Promise<{ byMessage: Map<string, TurnView>; orphans: TurnView[] }> {
  let rows: ReadableTurnContext[] = [];
  try {
    rows = await loadTurnContexts(db, {
      conversationId: opts.conversationId,
      viewerId: opts.viewerId,
    });
  } catch {
    // A transcript that loads without its context panels is a far better page
    // than a transcript that 500s. Diagnostics never break the thing they are
    // diagnosing.
    return { byMessage: new Map(), orphans: [] };
  }

  // Timings live in their own table (0084) and are joined here by the assistant
  // message, which is the only key both sides are sure to agree on. A separate
  // read rather than a join: it is one indexed lookup, it fails independently,
  // and a conversation whose timings are missing still draws its contexts.
  const timings = new Map<string, LatencyView>();
  try {
    const measured = await loadTurnLatencies(db, { conversationId: opts.conversationId });
    for (const row of measured) {
      if (row.messageId) timings.set(row.messageId, toLatency(row));
    }
  } catch {
    // Same posture as above: diagnostics never break the thing they diagnose.
  }

  const byMessage = new Map<string, TurnView>();
  const orphans: TurnView[] = [];
  for (const row of rows) {
    const view = toTurn(
      row,
      opts.livePromptDigest,
      (row.messageId && timings.get(row.messageId)) || null,
    );
    if (view.messageId) byMessage.set(view.messageId, view);
    else orphans.push(view);
  }
  return { byMessage, orphans };
}
