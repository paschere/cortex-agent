/**
 * Reading a captured turn back — and the privacy rule that governs it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN ONE OF THESE ROWS
 * ---------------------------------------------------------------------------
 * Passages out of Brain Knowledge, chosen by a question somebody asked. Some of
 * those passages come from GLOBAL spaces, which everyone in the workspace can
 * already retrieve. Some come from the asker's PERSONAL spaces, which exactly
 * one person can retrieve — that is what a personal space is (see kb/spaces.ts,
 * `listVisibleSpaces`: no admin branch, deliberately, because publishing
 * company knowledge is not the same as being able to read everyone's notes).
 *
 * So a captured turn can hold material that its reader would be refused if they
 * asked for it directly. Storing it was necessary; handing it over is not.
 *
 * ---------------------------------------------------------------------------
 * TWO GATES, AND THEY DO DIFFERENT JOBS
 * ---------------------------------------------------------------------------
 * FIRST, WHOSE CONVERSATION IS IT. Enforced by the caller, with the same rule
 * the transcript page has always used: the person it belongs to, or an org
 * admin — who is shown a banner saying they are reading somebody else's
 * conversation. Reading another person's context is therefore possible and
 * never quiet, which is the correct shape for an oversight power.
 *
 * SECOND, WHOSE KNOWLEDGE IS IT. Enforced here, and it does NOT dissolve for an
 * admin. Every fragment's space is checked against what the VIEWER can see, and
 * a fragment from a space they cannot is returned with its text stripped and
 * `withheld` set. The numbers survive — the score, the verdict, whether it was
 * prepended, which space kind it came from — because those are what make the
 * turn diagnosable, and none of them quote anybody. An admin can therefore still
 * answer "why did it say that" (four fragments came back, three cleared the
 * floor, one was from a personal space) without being handed the contents of a
 * colleague's private notes as a side effect of debugging.
 *
 * This is deliberately stricter than the transcript page next door, which shows
 * an admin the full tool results. It is stricter because the material is
 * different: a tool result is what the agent did on somebody's behalf, and a
 * prepended fragment is a quotation out of a private space that the person
 * being read never chose to show anyone.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { listVisibleSpaces } from '../kb/spaces';
import type {
  CapturedFragment,
  CapturedInstructions,
  CapturedMemory,
  CapturedRetrieval,
  CapturedToolOffer,
  ContextPart,
} from './types';

/** A fragment as a particular reader is allowed to see it. */
export interface ReadableFragment extends CapturedFragment {
  /** True when the reader may not see this space; `excerpt` is then null. */
  withheld: boolean;
}

export interface ReadableTurnContext {
  id: string;
  messageId: string | null;
  createdAt: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  parts: ContextPart[];
  instructions: CapturedInstructions;
  memories: CapturedMemory[];
  retrieval: Omit<CapturedRetrieval, 'fragments'> & { fragments: ReadableFragment[] };
  tools: CapturedToolOffer;
  overridden: boolean;
  /**
   * True once the quoted material has aged out and been stripped from the row.
   * Said out loud on screen: a turn with no excerpts because it is five weeks
   * old must not read like a turn that retrieved nothing.
   */
  redacted: boolean;
}

interface Row {
  id: string;
  message_id: string | null;
  created_at: string;
  model: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  parts: ContextPart[] | null;
  instructions: CapturedInstructions | null;
  memories: CapturedMemory[] | null;
  retrieval: CapturedRetrieval | null;
  tools: CapturedToolOffer | null;
  overridden: boolean | null;
  redacted_at: string | null;
}

const EMPTY_RETRIEVAL: CapturedRetrieval = {
  ran: false,
  skipped: null,
  query: '',
  coverage: 'nothing',
  summary: '',
  cuts: { modelId: '', strongMatch: 0, weakFloor: 0, railCeiling: 1, measured: false },
  limit: 0,
  fragments: [],
};

const EMPTY_TOOLS: CapturedToolOffer = {
  reason: 'below-threshold',
  candidates: 0,
  offered: [],
  families: [],
};

/**
 * Every captured turn of one conversation, as this viewer may see it.
 *
 * The caller has already decided the viewer may read this conversation. What
 * this function decides is which fragments they may read the text of.
 */
export async function loadTurnContexts(
  db: SupabaseClient,
  opts: { conversationId: string; viewerId: string },
): Promise<ReadableTurnContext[]> {
  const { data, error } = await db
    .from('turn_contexts')
    .select(
      'id, message_id, created_at, model, prompt_tokens, completion_tokens, parts, instructions, memories, retrieval, tools, overridden, redacted_at',
    )
    .eq('conversation_id', opts.conversationId)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const rows = (data ?? []) as unknown as Row[];
  if (rows.length === 0) return [];

  // One lookup for the whole page rather than one per fragment. Global spaces
  // are in here too, so the check below is a single set membership and not a
  // kind-plus-owner special case that could be got wrong twice.
  const visible = new Set((await listVisibleSpaces(db, opts.viewerId)).map((s) => s.id));

  return rows.map((row) => {
    const retrieval = row.retrieval ?? EMPTY_RETRIEVAL;
    const fragments: ReadableFragment[] = (retrieval.fragments ?? []).map((f) => {
      const allowed = visible.has(f.spaceId);
      return {
        ...f,
        withheld: !allowed,
        // Stripped rather than trimmed. There is no partial version of "you may
        // not read this space".
        excerpt: allowed ? f.excerpt : null,
      };
    });

    return {
      id: row.id,
      messageId: row.message_id,
      createdAt: row.created_at,
      model: row.model,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      parts: row.parts ?? [],
      instructions: row.instructions ?? { chars: 0, digest: '' },
      memories: row.memories ?? [],
      retrieval: { ...retrieval, fragments },
      tools: row.tools ?? EMPTY_TOOLS,
      overridden: row.overridden ?? false,
      redacted: row.redacted_at !== null,
    };
  });
}
