/**
 * The three things a person may change about what Cortex is handed, and the one
 * scope they change it for.
 *
 * ---------------------------------------------------------------------------
 * THE SCOPE IS THE CONVERSATION. THAT IS A DECISION, NOT A LIMITATION.
 * ---------------------------------------------------------------------------
 * The obvious design is a settings page: knobs on the agent, or on the
 * workspace, filed under Configuración. It was rejected, for one reason.
 *
 * These knobs get touched by somebody who has just had a bad answer and has
 * this page open to find out why. That person is mid-diagnosis. An adjustment
 * made in that state must not be able to change what anybody else's assistant
 * does — and a workspace-scoped "offer fewer fragments" set on a Tuesday
 * afternoon by an administrator chasing one wrong reply is exactly the change
 * that is never undone, never remembered, and shows up six weeks later as "the
 * brain stopped working" with nothing on screen connecting the two.
 *
 * Conversation scope makes the experiment contained and legible: it changes the
 * thing you are looking at, it is visible on every turn it affected (each
 * captured turn records whether an adjustment was in force), and starting a new
 * conversation is a full reset that needs no undo button. If a change turns out
 * to be right for everybody, it belongs in the agent's own configuration, made
 * deliberately, by somebody who decided it rather than by somebody who was
 * debugging.
 *
 * WHY THESE THREE AND NOTHING ELSE. Each one answers a failure this surface
 * actually shows you:
 *
 *   fragmentLimit  You saw four fragments prepended and three of them were
 *                  noise crowding out the good one — or you saw the good one
 *                  sitting just outside the window.
 *   spaceIds       You saw the answer come out of the wrong space.
 *   mutedFamilies  You saw a family of tools offered that had no business being
 *                  on this turn, pulling the model toward calling something.
 *
 * Everything else people would ask for — thresholds, the ranking band, the
 * model — is either measured elsewhere (relevance.ts, and it is measured for a
 * reason) or is not a per-conversation question. A panel of a hundred knobs is
 * a panel nobody understands, and a knob nobody understands is worse than no
 * knob at all.
 *
 * NARROWING ONLY. `spaceIds` reaches Brain Knowledge through
 * `ToolContext.kbSpaceIds`, which the database intersects with what the person
 * can already see. So this cannot be used to reach a space the user could not
 * otherwise retrieve from: it is a filter on their own visibility and nothing
 * more. `mutedFamilies` likewise only ever removes tools, never adds one that
 * the agent's grants and the team deny-list did not already allow.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** Nothing in force. The shape a conversation has until somebody changes it. */
export const NO_OVERRIDES: TurnContextOverrides = {
  fragmentLimit: null,
  spaceIds: null,
  mutedFamilies: [],
};

export interface TurnContextOverrides {
  /**
   * How many Brain Knowledge fragments to prepend. Null means the default.
   * Zero is a real and useful value — "answer without the brain this time" —
   * and must not be collapsed into null.
   */
  fragmentLimit: number | null;
  /** Narrow retrieval to these spaces. Null means everything the person sees. */
  spaceIds: string[] | null;
  /** Tool families not to offer in this conversation. */
  mutedFamilies: string[];
}

/** The ceiling on the knob, matching the RAG block the chat route builds. */
export const MAX_PREPENDED_FRAGMENTS = 8;

export function hasOverrides(o: TurnContextOverrides): boolean {
  return o.fragmentLimit !== null || o.spaceIds !== null || o.mutedFamilies.length > 0;
}

interface Row {
  fragment_limit: number | null;
  space_ids: string[] | null;
  muted_families: string[] | null;
}

function toOverrides(row: Row | null): TurnContextOverrides {
  if (!row) return NO_OVERRIDES;
  return {
    fragmentLimit:
      row.fragment_limit === null
        ? null
        : Math.max(0, Math.min(MAX_PREPENDED_FRAGMENTS, Number(row.fragment_limit))),
    // An empty array is stored as null on the way in (see `saveOverrides`), so
    // reading one back can only mean "no restriction". The distinction matters:
    // `kbSpaceIds: []` means "no space at all", and letting an empty array
    // through here would silently switch the brain off for the conversation.
    spaceIds: row.space_ids && row.space_ids.length > 0 ? row.space_ids : null,
    mutedFamilies: row.muted_families ?? [],
  };
}

/**
 * Read the adjustments in force for one conversation.
 *
 * NEVER THROWS. This runs on the chat's hot path, and a diagnostics setting
 * failing to load must cost the default behaviour, never the answer. The
 * failure mode of this whole feature is "Cortex behaves normally".
 */
export async function loadOverrides(
  db: SupabaseClient,
  conversationId: string,
): Promise<TurnContextOverrides> {
  if (!conversationId) return NO_OVERRIDES;
  try {
    const { data } = await db
      .from('turn_context_settings')
      .select('fragment_limit, space_ids, muted_families')
      .eq('conversation_id', conversationId)
      .maybeSingle();
    return toOverrides((data as Row | null) ?? null);
  } catch {
    return NO_OVERRIDES;
  }
}

export interface SaveOverridesInput {
  conversationId: string;
  userId: string;
  overrides: TurnContextOverrides;
}

/**
 * Write the adjustments for one conversation.
 *
 * The caller is responsible for having checked that this person may touch this
 * conversation — the same ownership rule the transcript page enforces. This
 * function is the storage, not the gate.
 */
export async function saveOverrides(
  db: SupabaseClient,
  { conversationId, userId, overrides }: SaveOverridesInput,
): Promise<void> {
  const limit =
    overrides.fragmentLimit === null
      ? null
      : Math.max(0, Math.min(MAX_PREPENDED_FRAGMENTS, Math.trunc(overrides.fragmentLimit)));

  const { error } = await db.from('turn_context_settings').upsert(
    {
      conversation_id: conversationId,
      fragment_limit: limit,
      // Collapsed to null on the way in so the "no restriction" state has
      // exactly one representation in the column. See `toOverrides`.
      space_ids: overrides.spaceIds && overrides.spaceIds.length > 0 ? overrides.spaceIds : null,
      muted_families: overrides.mutedFamilies,
      updated_by: userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'conversation_id' },
  );
  if (error) throw error;
}
