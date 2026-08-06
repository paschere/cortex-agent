import { buildToolContext } from '@/lib/agent';
import { sendApprovalRequestEmail } from '@/lib/approval-email';
import { confirmationReason } from '@/lib/confirmation-notes';
import { toChatText } from '@/lib/google-chat';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { chatModel } from '@cortex/agent-tools';
import {
  type RiskLevel,
  classify,
  familyOf,
  filterTools,
  findMemoryEcho,
  kbSearch,
  maxLevel,
  runTool,
  selectToolsForTurn,
} from '@cortex/agent-tools';
import { loadAgent } from '@cortex/agents';
import { ConfirmationRequiredError, logger } from '@cortex/core';
import { type CoreMessage, type CoreTool, generateText, tool } from 'ai';
import type { ChatAudience } from './events';

/**
 * One Cortex turn, driven from Google Chat.
 *
 * Same brain as the web chat (apps/web/app/api/chat/route.ts): the same agent
 * row, the same system prompt, the same `filterTools` → team deny-list →
 * semantic selection → AI SDK wiring, the same conversation/message
 * persistence. Two things differ:
 *
 *   1. No streaming. Chat wants one finished message, so this uses
 *      `generateText` instead of `streamText`.
 *   2. It is AUDIENCE-AWARE. See the privacy guard below — a group space is a
 *      broadcast, and that changes what may be said out loud.
 *
 * Tool scoping used to be skipped here on purpose: the web route narrowed the
 * catalogue with a hand-written regex per family, and keeping a second copy of
 * that list in sync was worse than sending everything. `selectToolsForTurn`
 * removed the list, and with it the reason — there is nothing left to drift, so
 * both surfaces now call the same function and Chat gets the same benefit
 * (fewer, better-chosen declarations) that the web chat has always had.
 */

/** How long a staged approval stays valid — same as the MCP surface. */
const PENDING_ACTION_TTL_MS = 15 * 60_000;

/**
 * THE PRIVACY GUARD.
 *
 * Every individual permission can check out and the answer can still be a leak:
 * "what does María earn?" asked in a space with eight people is a compensation
 * disclosure to seven of them. Personal permissions authorise the ASKER to see
 * something; they say nothing about the other people in the room.
 *
 * So in a SPACE (never in a DM) an answer is withheld from the room and
 * delivered to the sender privately when the turn touched:
 *
 *   - a financial family — payroll.*                        → compensation
 *   - a PII-heavy family — presentations.*, people.*,
 *     gmail.*                                               → personal data
 *   - anything the security classifier rates high/critical  → everything else
 *
 * Aggregates and ordinary answers (CRM, Linear, GitHub, Brain Knowledge, the web) post
 * normally: the guard exists to stop leaks, not to make the bot useless.
 *
 * A FOURTH REASON, added with user memories (migration 0051): the answer
 * REPEATS one of the asker's own memories. Memories are personal notes that
 * shape every turn, including this one — Cortex still honours "always quote in
 * USD" in a room of eight people, and should. What must never happen is the
 * note itself surfacing: nobody else in the space can see it, nobody consented
 * to it being read out, and "why does the bot know that about me" is the exact
 * shape of leak this guard exists to prevent. The system prompt asks the model
 * not to; `findMemoryEcho` checks the finished text and redirects it if it did,
 * because asking is not a guarantee.
 *
 * `payroll` is listed as FINANCIAL at the family level, not tool by tool, and
 * that is deliberate. The family's own tool classification distinguishes a
 * headcount rollup from a salary, but this guard cannot rely on that: a single
 * turn mixes tools — Cortex answers "how big is the team on Acme, and what do
 * they cost?" with a rollup call AND a per-person call, and only the coarse
 * family signal is available by the time the answer is assembled. Withholding
 * a "how many people are on Acme" answer into a DM is a mild annoyance;
 * answering "what does María earn?" out loud to seven colleagues is not
 * recoverable. The blunt rule is the right one.
 *
 * If this list ever loosens, loosen it deliberately — this rule is the
 * difference between a useful team bot and a data-leak vector.
 */
const FINANCIAL_FAMILIES = new Set(['payroll']);
const PII_FAMILIES = new Set(['presentations', 'people', 'gmail']);

export interface ChatTurnRequest {
  organizationId: string;
  userId: string;
  /** Display name of the sender, for the greeting and conversation title. */
  senderName?: string;
  space: string;
  spaceDisplayName?: string;
  audience: ChatAudience;
  threadName?: string;
  conversationKey: string;
  userText: string;
  /** Extra instruction from a slash command, folded into the system prompt. */
  directive?: string;
  /**
   * Which messaging surface this turn came from. Google Chat by default.
   *
   * WhatsApp reuses this whole function rather than growing a second copy of
   * it: the brain, the tool wiring, the retrieval, the persistence and the
   * privacy guard are the same on any messaging surface, and the only things
   * that differ are what the model should be told about the room and what the
   * audit row should say. Both are strings, so both are parameters.
   */
  surfaceKey?: 'google_chat' | 'whatsapp';
  /** Replaces the default note describing the room to the model. */
  surfaceNote?: string;
  /** Title prefix for the conversation row, so the history reads correctly. */
  titlePrefix?: string;
  /**
   * A further NARROWING of the tool catalogue, applied after the agent's grant
   * and the caller's team deny-list.
   *
   * It exists for one situation and should stay that way: answering out loud in
   * a WhatsApp group, where the room contains clients and suppliers and the
   * reach has to be smaller than it is in a private conversation with the same
   * person (migration 0072). It can only ever remove.
   */
  toolFilter?: (toolId: string) => boolean;
  /**
   * A ceiling on Brain Knowledge retrieval, for both the RAG prepend below and
   * every `kb.*` tool the model calls — it rides on the ToolContext, so there
   * is no second path that could miss it. `[]` means "no space at all";
   * undefined means "whatever this person can see".
   */
  kbSpaceIds?: string[];
}

export interface ChatTurnDelivery {
  /** Chat-formatted text to post in the originating thread. Always present. */
  publicText: string;
  /**
   * Chat-formatted text that must reach the SENDER privately — either because
   * the answer was withheld from the space, or because it is an approval
   * request that only the requester may act on. Null when nothing is private.
   */
  privateText: string | null;
  conversationId: string | null;
  /** Set when the answer itself was redirected out of the space. */
  withheldReason: WithheldReason | null;
}

type WithheldReason = 'financial' | 'pii' | 'risk' | 'memory';

interface StagedConfirmation {
  id: string | null;
  toolId: string;
  input: unknown;
}

function appBase(): string {
  return (process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
}

function humanizeToolId(toolId: string): string {
  const [family = '', ...rest] = toolId.split('.');
  const action = rest
    .join('.')
    .split('_')
    .map((w) => (w ? `${w[0]?.toUpperCase() ?? ''}${w.slice(1)}` : w))
    .join(' ');
  const familyTitle = family ? `${family[0]?.toUpperCase() ?? ''}${family.slice(1)}` : family;
  return action ? `${familyTitle} · ${action}` : familyTitle;
}

function toToolErrorMessage(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  const brace = msg.indexOf('{');
  if (brace !== -1) {
    try {
      const parsed = JSON.parse(msg.slice(brace)) as {
        error?: { message?: string };
        message?: string;
      };
      const inner = parsed?.error?.message ?? parsed?.message;
      if (typeof inner === 'string' && inner.length > 0) msg = inner;
    } catch {
      // not JSON — keep the original string
    }
  }
  return msg.length > 600 ? `${msg.slice(0, 600)}…` : msg;
}

const ACKNOWLEDGMENT_RE =
  /^(ok|yes|no|sure|thanks|got it|sounds good|proceed|continue|sí|claro|dale|perfecto|de acuerdo)[.!?]?$/i;

function shouldRunRag(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.split(/\s+/).length < 8) return false;
  return !ACKNOWLEDGMENT_RE.test(trimmed);
}

/**
 * Chat threads reuse `conversations` like every other surface, keyed by
 * `external_key`. NOTE: `chat_surface` is an enum of ('web','desktop','mcp')
 * with no Chat value, so rows are stored as 'mcp' — the closest existing
 * "external client" bucket. The `gchat:` prefix on external_key and the title
 * are what actually identify the surface until the enum gains a 'chat' member.
 */
async function getOrCreateConversation(opts: {
  organizationId: string;
  userId: string;
  agentId: string;
  externalKey: string;
  title: string;
}): Promise<string | null> {
  const db = getOrgScopedClient(opts.organizationId);
  try {
    const { data: existing } = await db
      .from('conversations')
      .select('id')
      .eq('user_id', opts.userId)
      .eq('external_key', opts.externalKey)
      .maybeSingle();
    if (existing?.id) return existing.id as string;

    const { data: created, error } = await db
      .from('conversations')
      .insert({
        user_id: opts.userId,
        agent_id: opts.agentId,
        surface: 'mcp',
        title: opts.title.slice(0, 60),
        external_key: opts.externalKey,
      })
      .select('id')
      .single();
    if (error || !created) return null;
    return created.id as string;
  } catch (err) {
    logger.error('google-chat: conversation lookup failed', { error: (err as Error).message });
    return null;
  }
}

/** Stage an approval so it shows up on /approvals. Returns the row id. */
async function stageConfirmation(opts: {
  organizationId: string;
  userId: string;
  agentId: string;
  toolId: string;
  input: unknown;
  expiresAt: Date;
}): Promise<string | null> {
  try {
    const db = getOrgScopedClient(opts.organizationId);
    const { data, error } = await db
      .from('mcp_pending_actions')
      .insert({
        user_id: opts.userId,
        agent_id: opts.agentId,
        tool_id: opts.toolId,
        input: opts.input,
        expires_at: opts.expiresAt.toISOString(),
      })
      .select('id')
      .single();
    if (error || !data) return null;
    return data.id as string;
  } catch {
    return null;
  }
}

/**
 * The note that goes with a staged approval.
 *
 * It used to repeat the whole payload here and end in "open /approvals". The
 * payload now lives on the Approve/Decline CARD that `sendApprovalRequestEmail`
 * DMs the person (and in the email), so repeating it would put the same JSON on
 * screen twice and bury the buttons. What stays is the one thing the card can't
 * say: which of them, and that nothing has happened yet.
 */
function buildConfirmationBlock(confirmations: StagedConfirmation[]): string {
  if (confirmations.length === 0) return '';
  const base = appBase();
  const staged = confirmations.filter((c) => c.id);
  const failed = confirmations.filter((c) => !c.id);

  const lines: string[] = ['⏸️ Nothing has run yet.', ''];
  for (const c of staged) {
    lines.push(`• **${humanizeToolId(c.toolId)}** — ${confirmationReason(c.toolId)}`);
  }
  for (const c of failed) {
    // No row means there is nothing to approve anywhere — say so instead of
    // pointing at a queue that will be empty.
    lines.push(
      `• **${humanizeToolId(c.toolId)}** — I couldn't even set that one up for approval. Ask me again in a moment.`,
    );
  }

  if (staged.length > 0) {
    lines.push('');
    lines.push(
      base
        ? `Approve or Decline right on the card I sent you — or from [Cortex](${base}/approvals). It expires in 15 minutes.`
        : 'Approve or Decline right on the card I sent you. It expires in 15 minutes.',
    );
  }
  return lines.join('\n');
}

const WITHHELD_NOTE: Record<WithheldReason, string> = {
  financial: 'That one carries compensation data, so I sent it to you directly ⚡',
  pii: 'That one carries personal data, so I sent it to you directly ⚡',
  risk: 'That answer is too sensitive for a group space, so I sent it to you directly ⚡',
  // Says nothing about what the note contains — the note is the thing being
  // protected, and "I know something private about you" is already more than
  // the room needs.
  memory: 'That one got personal, so I sent it to you directly ⚡',
};

const APPROVAL_IN_SPACE_NOTE =
  'It needs your approval before I run it — I sent the request to you directly.';

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export async function runChatTurn(req: ChatTurnRequest): Promise<ChatTurnDelivery> {
  const db = getOrgScopedClient(req.organizationId);
  const agent = await loadAgent(db, 'cortex');

  const prefix = req.titlePrefix ?? 'Chat';
  const title =
    req.audience === 'dm'
      ? `${prefix} · ${req.senderName ?? 'Google Chat'}`
      : `${prefix} · ${req.spaceDisplayName ?? req.space}`;

  const conversationId = await getOrCreateConversation({
    organizationId: req.organizationId,
    userId: req.userId,
    agentId: agent.id,
    externalKey: req.conversationKey,
    title,
  });

  if (conversationId) {
    await db
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'user', content: req.userText })
      .then(undefined, () => undefined);
  }

  const ctx = buildToolContext({
    organizationId: req.organizationId,
    userId: req.userId,
    agentId: agent.id,
    ...(conversationId ? { conversationId } : {}),
    // Spread conditionally so an absent restriction stays absent — passing
    // `undefined` explicitly would be the same thing, but an empty array must
    // survive as an empty array, and being explicit here says so.
    ...(req.kbSpaceIds ? { kbSpaceIds: req.kbSpaceIds } : {}),
  });

  // --- retrieval (same conditional RAG prepend as the web chat) -------------
  let ragBlock = '';
  try {
    // kb_documents, not kb_chunks: chunks inherit their workspace from their
    // document (migration 0064 § 12), so counting them install-wide would tell
    // a workspace with an empty brain that it has one.
    const { count } = await db.from('kb_documents').select('id', { count: 'exact', head: true });
    if ((count ?? 0) > 0 && shouldRunRag(req.userText)) {
      // THE CUT THAT USED TO LIVE HERE WAS THE BUG, AND IT OUTLIVED ITS OWN FIX.
      //
      // This block filtered `score >= 0.65` on the BLENDED rank — 0.7 × cosine
      // plus 0.3 × ts_rank — long after `kb.search` had moved the decision onto
      // cosine similarity, where a threshold means something. On a corpus with
      // no literal keyword overlap the blend never reaches 0.65: a passage that
      // answers the question perfectly scores about 0.63 cosine, which is 0.44
      // blended. So this surface discarded every correct result it was ever
      // handed and then said nothing about it — no empty-context sentence, no
      // log line, just a missing <context> block and a model quietly answering
      // from its own head. The web chat route was fixed; this one was not, and
      // a silent omission leaves no trace to notice it by.
      //
      // The tool has already applied the relevance cuts for the model that
      // produced the scores, dropped what is below the floor, and written a
      // sentence about what it concluded. There is nothing left to threshold.
      const ragOut = await runTool(kbSearch, { query: req.userText, limit: 3 }, ctx).catch(
        () => null,
      );

      if (ragOut && ragOut.coverage === 'nothing') {
        // Stated, not skipped — for the same reason the web chat states it. An
        // absent context block is indistinguishable from "retrieval did not
        // run", and a model that cannot tell the difference fills the silence.
        ragBlock = `<context>\n${ragOut.summary}\n</context>`;
      } else if (ragOut && ragOut.hits.length > 0) {
        // The age and the "coincidencia débil" marker travel with each citation
        // because they change what it is worth: a rate quoted from a year-old
        // document is a different claim from the same rate quoted last week,
        // and a tangential hit presented like an answer is the original bug.
        const cited = ragOut.hits
          .map(
            (h, i) =>
              `[^${i + 1}] ${h.documentTitle} chunk ${h.chunkIndex}` +
              `${h.age ? ` · ${h.age}` : ''}` +
              `${h.relevance === 'weak' ? ' · coincidencia débil' : ''}:\n${h.content}`,
          )
          .join('\n\n');
        ragBlock = `<context>\n${ragOut.summary}\n\n${cited}\n</context>`;
      }
    }
  } catch {
    // Retrieval is an optimisation, never a precondition.
  }

  // --- tools: agent allow-list minus the user's team deny-list --------------
  const denied = await deniedToolPatterns(db, req.userId);
  const granted = filterTools(agent.allowedTools)
    .filter((t) => denied.length === 0 || !isToolDenied(t.id, denied))
    // The surface's own ceiling, last, so it can only ever subtract from what
    // the person was already allowed.
    .filter((t) => (req.toolFilter ? req.toolFilter(t.id) : true));

  // ...then narrowed by meaning, the same way and by the same function as the
  // web chat. A Chat message is the shortest input any surface gets ("@cortex
  // qué pasó con Acme?"), which is exactly the case the selector is tuned for:
  // no match clears the bar, the base families still travel, and anything not
  // yet indexed is sent rather than hidden.
  const selection = await selectToolsForTurn({ db, tools: granted, query: req.userText });
  const allowed = selection.tools;
  logger.debug('google-chat tool selection', {
    reason: selection.reason,
    offered: allowed.length,
    of: granted.length,
    families: selection.selectedFamilies,
  });

  const confirmations: StagedConfirmation[] = [];
  const familiesUsed = new Set<string>();
  // Held in an object rather than a `let`: it is only ever written from inside
  // the tool closures, and TypeScript would otherwise narrow it to 'low'.
  const risk: { highest: RiskLevel } = { highest: 'low' };

  const aiTools: Record<string, CoreTool> = Object.fromEntries(
    allowed.map((t) => [
      t.id.replaceAll('.', '_'),
      tool({
        description: t.description,
        parameters: t.inputSchema,
        execute: async (args, { abortSignal }) => {
          familiesUsed.add(familyOf(t.id));
          // Pure, no I/O: records how sensitive this turn actually got so the
          // privacy guard below can decide where the answer may be delivered.
          try {
            const classification = classify({
              tool: { id: t.id, ...(t.requiresConfirmation ? { requiresConfirmation: true } : {}) },
              input: args,
              surface: 'web',
            });
            risk.highest = maxLevel(risk.highest, classification.riskLevel);
          } catch {
            // classification is advisory here; runTool enforces for real.
          }

          try {
            const out = await runTool(t, args, { ...ctx, signal: abortSignal });
            // `runTool` attaches `_security` to any call the enforcement layer
            // treats as an incident. That verdict is the authoritative one —
            // it saw the real policy and the trailing-hour frequency signal —
            // so it overrides the pure pre-flight classification above.
            const flagged = (out as { _security?: { riskLevel?: RiskLevel } } | null | undefined)
              ?._security?.riskLevel;
            if (flagged) risk.highest = maxLevel(risk.highest, flagged);
            return out;
          } catch (err) {
            if (err instanceof ConfirmationRequiredError) {
              // NEVER execute. Stage it, notify the requester privately (email
              // + DM via approval-email), and tell the model to stop here.
              const expiresAt = new Date(Date.now() + PENDING_ACTION_TTL_MS);
              const id = await stageConfirmation({
                organizationId: req.organizationId,
                userId: req.userId,
                agentId: agent.id,
                toolId: err.toolId,
                input: err.input,
                expiresAt,
              });
              confirmations.push({ id, toolId: err.toolId, input: err.input });
              // Carries the id, so the DM arrives as a card with Approve /
              // Decline buttons instead of a link out of Chat.
              void sendApprovalRequestEmail({
                organizationId: req.organizationId,
                userId: req.userId,
                toolId: err.toolId,
                input: err.input,
                surface: req.surfaceKey === 'whatsapp' ? 'whatsapp' : 'chat',
                ...(id ? { pendingActionId: id } : {}),
                expiresAt,
              });
              return {
                __requires_confirmation: true,
                tool: t.id,
                message:
                  'NOT executed. This action needs the person to approve it first, and the approval request has already been sent to them privately. Do not retry it. Say in one short sentence what you were about to do and that it is waiting for their approval.',
              } as unknown as never;
            }
            return {
              __error: true,
              tool: t.id,
              message: toToolErrorMessage(err),
            } as unknown as never;
          }
        },
      }),
    ]),
  );

  // --- history --------------------------------------------------------------
  let messages: CoreMessage[] = [{ role: 'user', content: req.userText }];
  if (conversationId) {
    try {
      const { data: rows } = await db
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (rows && rows.length > 0) {
        messages = rows
          .reverse()
          .filter((m) => typeof m.content === 'string' && (m.content as string).length > 0)
          .map((m) => ({
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content as string,
          }));
        const last = messages[messages.length - 1];
        if (!last || last.role !== 'user') messages.push({ role: 'user', content: req.userText });
      }
    } catch {
      // fall back to the single message
    }
  }

  // --- system prompt --------------------------------------------------------
  const surfaceNote =
    req.surfaceNote ??
    (req.audience === 'space'
      ? 'You are answering in a Google Chat SPACE — a group room where everyone present reads your reply. People reach you by @mentioning you. Keep answers short and chat-shaped (a few lines, no headings, no tables). Anything involving compensation, payroll or personal data is delivered to the person privately instead of being posted here; do not restate such details in your reply.'
      : 'You are answering in a 1:1 Google Chat DM. Keep answers short and chat-shaped (a few lines, no headings, no tables) unless the person asks for detail.');

  // The same builder the web chat and MCP use, so a person's memories reach
  // every surface or none. `audience: 'group'` adds the do-not-repeat rule to
  // the prompt; the enforcement is below, on the finished text.
  const { system, memories } = await buildSystemPrompt({
    organizationId: req.organizationId,
    userId: req.userId,
    basePrompt: agent.systemPrompt,
    audience: req.audience === 'space' ? 'group' : 'private',
    sections: [`---\n${surfaceNote}`, req.directive, ragBlock],
  });

  let answer = '';
  try {
    const result = await generateText({
      model: chatModel(agent.defaultModel),
      system,
      messages,
      // An empty object is not the same as no tools: some providers reject a
      // request that declares zero of them. A surface that deliberately offers
      // none (a WhatsApp group at `plain` scope) must still get an answer.
      ...(allowed.length > 0 ? { tools: aiTools, toolChoice: 'auto' as const } : {}),
      maxSteps: 12,
    });
    answer = result.text.trim();

    if (conversationId) {
      await db
        .from('messages')
        .insert({
          conversation_id: conversationId,
          role: 'assistant',
          content: answer,
          tool_calls: result.toolCalls as unknown as object,
          tool_results: result.toolResults as unknown as object,
        })
        .then(undefined, () => undefined);
      await db
        .from('audit_events')
        .insert({
          user_id: req.userId,
          agent_id: agent.id,
          conversation_id: conversationId,
          tool_id: '__agent_turn',
          input_hash: 'turn',
          status: 'ok',
          latency_ms: 0,
          metadata: {
            model: agent.defaultModel,
            surface: req.surfaceKey ?? 'google_chat',
            audience: req.audience,
            space: req.space,
            tokensIn: result.usage?.promptTokens ?? 0,
            tokensOut: result.usage?.completionTokens ?? 0,
          },
        })
        .then(undefined, () => undefined);
    }
  } catch (err) {
    // In the message, not in a context object: the platform log drain carries
    // only `msg`, so anything passed as structured context is invisible exactly
    // when a turn has failed and the reason is the only thing worth having.
    logger.error(
      `google-chat: turn failed — ${(err as Error).name}: ${(err as Error).message}\n${(err as Error).stack ?? ''}`,
    );
    answer = "I couldn't finish that one — something broke on my side. Try again in a moment.";
  }

  if (!answer) answer = 'Done — but I have nothing to add.';

  // --- privacy guard --------------------------------------------------------
  let withheldReason: ChatTurnDelivery['withheldReason'] = null;
  if (req.audience === 'space') {
    const hitFinancial = [...familiesUsed].some((f) => FINANCIAL_FAMILIES.has(f));
    const hitPii = [...familiesUsed].some((f) => PII_FAMILIES.has(f));
    const hitRisk = risk.highest === 'high' || risk.highest === 'critical';
    // Deterministic, on the finished text: no tool has to have been called for
    // a memory to end up quoted, so the family signals above cannot see this.
    const echoed = findMemoryEcho(answer, memories);
    if (hitFinancial) withheldReason = 'financial';
    else if (hitPii) withheldReason = 'pii';
    else if (hitRisk) withheldReason = 'risk';
    else if (echoed) {
      withheldReason = 'memory';
      // The id only — logging the content would move the note into the log
      // drain, which is one of the places memories are not supposed to reach.
      logger.warn('google-chat: answer repeated a personal memory, redirected to DM', {
        space: req.space,
        memoryId: echoed,
      });
    }
  }

  const confirmBlock = buildConfirmationBlock(confirmations);

  if (req.audience === 'dm') {
    return {
      publicText: toChatText(confirmBlock ? `${answer}\n\n${confirmBlock}` : answer),
      privateText: null,
      conversationId,
      withheldReason: null,
    };
  }

  // In a space the approval request itself is private: nobody but the requester
  // may act on it, and the payload can contain things the room should not see.
  if (withheldReason) {
    const note = `${WITHHELD_NOTE[withheldReason]}${
      confirmations.length > 0 ? ` ${APPROVAL_IN_SPACE_NOTE}` : ''
    }`;
    return {
      publicText: toChatText(note),
      privateText: toChatText(confirmBlock ? `${answer}\n\n${confirmBlock}` : answer),
      conversationId,
      withheldReason,
    };
  }

  return {
    publicText: toChatText(
      confirmations.length > 0 ? `${answer}\n\n_${APPROVAL_IN_SPACE_NOTE}_` : answer,
    ),
    privateText: confirmBlock ? toChatText(confirmBlock) : null,
    conversationId,
    withheldReason: null,
  };
}
