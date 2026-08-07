import 'server-only';
import { fragmentKey, heaviest, loadTurnContexts, shareOf } from '@cortex/agent-tools';
import type { ReadableTurnContext } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FragmentView, PartKey, TurnView } from '../_components/context/types';

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

function toTurn(row: ReadableTurnContext, livePromptDigest: string | null): TurnView {
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

  const byMessage = new Map<string, TurnView>();
  const orphans: TurnView[] = [];
  for (const row of rows) {
    const view = toTurn(row, opts.livePromptDigest);
    if (view.messageId) byMessage.set(view.messageId, view);
    else orphans.push(view);
  }
  return { byMessage, orphans };
}
