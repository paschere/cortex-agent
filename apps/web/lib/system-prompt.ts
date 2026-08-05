import 'server-only';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type MemoryAudience,
  type MemoryContextEntry,
  loadMemoryContext,
  renderMemoryBlock,
  touchMemories,
} from '@cortex/agent-tools';

/**
 * The one place a Cortex system prompt is assembled.
 *
 * WHY IT IS HERE AND NOT IN EACH ROUTE. Cortex answers on three surfaces — the
 * web chat (/api/chat), Google Chat (/api/chat-app/google/turn.ts) and MCP
 * (/api/mcp) — and each one used to build its own system prompt string. They
 * already drifted once: the web route scopes tools by conversation topic and
 * Chat deliberately does not, and the comment explaining that divergence is the
 * only thing keeping the two lists in sync. Adding a fourth thing every surface
 * must remember to include would drift the same way, and the failure would be
 * silent — a person's standing instructions quietly not applying on one surface,
 * with nothing to see. So the prompt is composed once and the surfaces pass in
 * what is genuinely surface-specific.
 *
 * ONE PLACE DELIBERATELY LEFT OUT: `inngest/functions/schedule-run.ts`, the
 * unattended routine runner. It executes on somebody's behalf while they are
 * not there, and its output goes to a recipient list that may be other people —
 * so a memory could reach a colleague's inbox with nobody in the loop to notice.
 * The group-space guard has no equivalent there (there is no answer to withhold
 * and no DM to withhold it into), so routines run without memories until one
 * exists. That is a deliberate omission, not an oversight.
 *
 * Memories are injected WHOLE, never retrieved. See migration 0051 for why:
 * retrieval fires on similarity, so a standing instruction would load exactly
 * when the question resembles it and silently fail to load the rest of the
 * time — which is when it still applies.
 */

export interface SystemPromptResult {
  /** The composed system prompt, ready to hand to the model. */
  system: string;
  /**
   * The memories that went in. Returned, not just used, because the Google Chat
   * surface has to check the finished answer against them before posting it
   * into a room — see `findMemoryEcho`.
   */
  memories: MemoryContextEntry[];
}

export interface SystemPromptOptions {
  /** The workspace the turn is happening in. Scopes the memory lookup. */
  organizationId: string;
  userId: string;
  /** The agent's own prompt, live from the `agents` row. */
  basePrompt: string;
  /**
   * Who will read the answer. 'group' adds the do-not-repeat rule for a room
   * with other people in it; it does NOT withhold the memories themselves,
   * because they still have to shape how Cortex behaves in that room.
   */
  audience?: MemoryAudience;
  /** Surface-specific blocks — the Chat surface note, a slash-command directive, retrieved context. */
  sections?: Array<string | null | undefined | false>;
}

export async function buildSystemPrompt(opts: SystemPromptOptions): Promise<SystemPromptResult> {
  const db = getOrgScopedClient(opts.organizationId);

  // A memory lookup that fails is a turn with less context, never a turn that
  // dies — loadMemoryContext already swallows its own errors and returns [].
  const memories = await loadMemoryContext(db, opts.userId);

  if (memories.length > 0) {
    // Fire-and-forget: this only feeds eviction ordering ("least recently
    // useful"), and no answer should wait on bookkeeping.
    touchMemories(
      db,
      opts.userId,
      memories.map((m) => m.id),
    );
  }

  const block = renderMemoryBlock(memories, opts.audience ?? 'private');

  const system = [opts.basePrompt, block, ...(opts.sections ?? [])]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');

  return { system, memories };
}
