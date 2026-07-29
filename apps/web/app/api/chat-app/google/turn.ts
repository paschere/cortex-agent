import { buildToolContext } from '@/lib/agent';
import { sendApprovalRequestEmail } from '@/lib/approval-email';
import { confirmationReason } from '@/lib/confirmation-notes';
import { toChatText } from '@/lib/google-chat';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { google } from '@ai-sdk/google';
import {
  type RiskLevel,
  classify,
  familyOf,
  filterTools,
  kbSearch,
  maxLevel,
  runTool,
} from '@zipdev/agent-tools';
import { loadAgent } from '@zipdev/agents';
import { ConfirmationRequiredError, logger } from '@zipdev/core';
import { type CoreMessage, type CoreTool, generateText, tool } from 'ai';
import type { ChatAudience } from './events';

/**
 * One Zippy turn, driven from Google Chat.
 *
 * Same brain as the web chat (apps/web/app/api/chat/route.ts): the same agent
 * row, the same system prompt, the same `filterTools` → team deny-list → AI SDK
 * wiring, the same conversation/message persistence. Two things differ:
 *
 *   1. No streaming. Chat wants one finished message, so this uses
 *      `generateText` instead of `streamText`.
 *   2. It is AUDIENCE-AWARE. See the privacy guard below — a group space is a
 *      broadcast, and that changes what may be said out loud.
 *
 * Tool scoping (the FAMILY_TRIGGERS trick in the web route) is deliberately not
 * replicated: like the MCP surface, Chat exposes the agent's full toolset, so
 * there is one fewer place for the two lists to drift apart.
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
 *   - a financial family — payroll.*, rate.*, bamboo.*       → compensation
 *   - a PII-heavy family — recruit.*, workable.*, people.*,
 *     gmail.*                                               → personal data
 *   - anything the security classifier rates high/critical  → everything else
 *
 * Aggregates and ordinary answers (CRM, Linear, GitHub, the KB, the web) post
 * normally: the guard exists to stop leaks, not to make the bot useless.
 *
 * `bamboo` is listed as FINANCIAL at the family level, not tool by tool, and
 * that is deliberate. BambooHR is the HR system of record: every active
 * employee's pay rate and bill rate live there, and the family's own tool
 * classification distinguishes a headcount from a salary. This guard cannot
 * rely on that distinction, because a single turn mixes tools — Zippy answers
 * "how big is the team on Acme, and what do they cost?" with a headcount call
 * AND a compensation call, and only the coarse family signal is available by
 * the time the answer is assembled. Withholding a "who is out this week"
 * answer into a DM is a mild annoyance; answering "what does María earn?" out
 * loud to seven colleagues is not recoverable. The blunt rule is the right one.
 *
 * If this list ever loosens, loosen it deliberately — this rule is the
 * difference between a useful team bot and a data-leak vector.
 */
const FINANCIAL_FAMILIES = new Set(['payroll', 'rate', 'bamboo']);
const PII_FAMILIES = new Set(['recruit', 'workable', 'people', 'gmail']);

export interface ChatTurnRequest {
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
  withheldReason: 'financial' | 'pii' | 'risk' | null;
}

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
  userId: string;
  agentId: string;
  externalKey: string;
  title: string;
}): Promise<string | null> {
  const db = getSupabaseServiceClient();
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
  userId: string;
  agentId: string;
  toolId: string;
  input: unknown;
  expiresAt: Date;
}): Promise<string | null> {
  try {
    const db = getSupabaseServiceClient();
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
        ? `Approve or Decline right on the card I sent you — or from [Zipdev OS](${base}/approvals). It expires in 15 minutes.`
        : 'Approve or Decline right on the card I sent you. It expires in 15 minutes.',
    );
  }
  return lines.join('\n');
}

const WITHHELD_NOTE: Record<'financial' | 'pii' | 'risk', string> = {
  financial: 'That one carries compensation data, so I sent it to you directly ⚡',
  pii: 'That one carries personal data, so I sent it to you directly ⚡',
  risk: 'That answer is too sensitive for a group space, so I sent it to you directly ⚡',
};

const APPROVAL_IN_SPACE_NOTE =
  'It needs your approval before I run it — I sent the request to you directly.';

// ---------------------------------------------------------------------------
// The turn
// ---------------------------------------------------------------------------

export async function runChatTurn(req: ChatTurnRequest): Promise<ChatTurnDelivery> {
  const db = getSupabaseServiceClient();
  const agent = await loadAgent(db, 'zippy');

  const title =
    req.audience === 'dm'
      ? `Chat · ${req.senderName ?? 'Google Chat'}`
      : `Chat · ${req.spaceDisplayName ?? req.space}`;

  const conversationId = await getOrCreateConversation({
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
    userId: req.userId,
    agentId: agent.id,
    ...(conversationId ? { conversationId } : {}),
  });

  // --- retrieval (same conditional RAG prepend as the web chat) -------------
  let ragBlock = '';
  try {
    const { count } = await db.from('kb_chunks').select('id', { count: 'exact', head: true });
    if ((count ?? 0) > 0 && shouldRunRag(req.userText)) {
      const ragOut = (await runTool(kbSearch, { query: req.userText, limit: 3 }, ctx).catch(() => ({
        hits: [],
      }))) as {
        hits: Array<{ score?: number; documentTitle: string; chunkIndex: number; content: string }>;
      };
      const relevant = (ragOut.hits ?? []).filter((h) => (h.score ?? 1) >= 0.65);
      if (relevant.length > 0) {
        ragBlock = `<context>\n${relevant
          .map(
            (h, i) =>
              `[^${i + 1}] (${(h.score ?? 0).toFixed(2)}) ${h.documentTitle} chunk ${h.chunkIndex}:\n${h.content}`,
          )
          .join('\n\n')}\n</context>`;
      }
    }
  } catch {
    // Retrieval is an optimisation, never a precondition.
  }

  // --- tools: agent allow-list minus the user's team deny-list --------------
  const denied = await deniedToolPatterns(db, req.userId);
  const allowed = filterTools(agent.allowedTools).filter(
    (t) => denied.length === 0 || !isToolDenied(t.id, denied),
  );

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
                userId: req.userId,
                toolId: err.toolId,
                input: err.input,
                surface: 'chat',
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
    req.audience === 'space'
      ? 'You are answering in a Google Chat SPACE — a group room where everyone present reads your reply. People reach you by @mentioning you. Keep answers short and chat-shaped (a few lines, no headings, no tables). Anything involving compensation, payroll or personal data is delivered to the person privately instead of being posted here; do not restate such details in your reply.'
      : 'You are answering in a 1:1 Google Chat DM. Keep answers short and chat-shaped (a few lines, no headings, no tables) unless the person asks for detail.';

  const system = [
    agent.systemPrompt,
    '',
    '---',
    surfaceNote,
    req.directive ? `\n${req.directive}` : '',
    ragBlock ? `\n${ragBlock}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  let answer = '';
  try {
    const result = await generateText({
      model: google(agent.defaultModel),
      system,
      messages,
      tools: aiTools,
      toolChoice: 'auto',
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
            surface: 'google_chat',
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
    if (hitFinancial) withheldReason = 'financial';
    else if (hitPii) withheldReason = 'pii';
    else if (hitRisk) withheldReason = 'risk';
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
