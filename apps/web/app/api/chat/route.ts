import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { NO_THINKING, chatModel, utilityModel } from '@cortex/agent-tools';
import {
  type AnyTool,
  type EnabledExternalServer,
  type ExternalServerRow,
  type RetrievalObservation,
  CUSTOM_TOOL_FAMILY,
  TurnContextRecorder,
  callExternalTool,
  customToolDef,
  familiesFrom,
  fetchEnabledCustomTools,
  fetchEnabledExternalTools,
  filterTools,
  fragmentKey,
  hasOverrides,
  kbSearch,
  loadOverrides,
  runTool,
  selectToolsForTurn,
  toolIdAllowed,
} from '@cortex/agent-tools';
import { loadAgent } from '@cortex/agents';
import { ConfirmationRequiredError, logger } from '@cortex/core';
import { type CoreMessage, type CoreTool, generateText, jsonSchema, streamText, tool } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * How many Brain Knowledge fragments get pasted above the question when nobody
 * has said otherwise. Unchanged from the number this route has always used; it
 * is a named constant now only because a conversation may override it.
 */
const DEFAULT_FRAGMENTS = 3;

const ACKNOWLEDGMENT_RE =
  /^(ok|yes|no|sure|thanks|got it|sounds good|proceed|continue|sí|claro|dale|perfecto|de acuerdo)[.!?]?$/i;

function shouldRunRag(message: string): boolean {
  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount < 8) return false;
  if (ACKNOWLEDGMENT_RE.test(message.trim())) return false;
  return true;
}

/**
 * A tool the model may be offered this turn, in the one shape
 * `selectToolsForTurn` needs to rank it. `ref` carries whatever the executor
 * needs afterwards, so the selection result can be turned straight back into
 * AI SDK tools without a second lookup.
 *
 * Built-in and external MCP tools are ranked TOGETHER and in one list. That is
 * the fix: they used to be two paths, and the external one had no scoping at
 * all because there was no regex anyone could write for a server a user
 * connected five minutes ago.
 */
type Candidate =
  | { id: string; family: string; description: string; kind: 'registry'; ref: AnyTool }
  | {
      id: string;
      family: string;
      description: string;
      kind: 'external';
      ref: {
        server: EnabledExternalServer['server'];
        entry: EnabledExternalServer['tools'][number];
      };
    };

/**
 * Distill a tool error into a concise, human-readable message the model can
 * relay to the user. Unwraps Google/HubSpot-style JSON error envelopes and caps
 * length so a giant 403 payload doesn't flood the context.
 */
function toToolErrorMessage(err: unknown): string {
  let msg = err instanceof Error ? err.message : String(err);
  // Many Google APIs throw with the raw JSON body as the message.
  const brace = msg.indexOf('{');
  if (brace !== -1) {
    try {
      const parsed = JSON.parse(msg.slice(brace));
      const inner = parsed?.error?.message ?? parsed?.message;
      if (typeof inner === 'string' && inner.length > 0) msg = inner;
    } catch {
      // not JSON — keep the original string
    }
  }
  return msg.length > 600 ? `${msg.slice(0, 600)}…` : msg;
}

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

const Body = z.object({
  agentSlug: z.string().default('cortex'),
  conversationId: z.string().uuid().optional(),
  messages: z.array(MessageSchema).min(1),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = Body.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { agentSlug, messages } = parsed.data;

  const db = getOrgScopedClient(user.organization.id);

  // Load agent from DB (gets UUID + system prompt stored in DB)
  let agent: Awaited<ReturnType<typeof loadAgent>>;
  try {
    agent = await loadAgent(db, agentSlug);
  } catch {
    return NextResponse.json({ error: `Agent '${agentSlug}' not found` }, { status: 404 });
  }

  // Resolve or create conversation
  let conversationId = parsed.data.conversationId;
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');

  if (!conversationId) {
    const title = (lastUserMessage?.content ?? 'New conversation').slice(0, 60);
    const { data: conv, error: convErr } = await db
      .from('conversations')
      .insert({
        user_id: user.id,
        agent_id: agent.id,
        surface: 'web',
        title,
      })
      .select('id')
      .single();
    if (convErr || !conv) {
      return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 });
    }
    conversationId = conv.id as string;
  }

  // Persist the user's last message
  if (lastUserMessage) {
    await db.from('messages').insert({
      conversation_id: conversationId,
      role: 'user',
      content: lastUserMessage.content,
    });
  }

  // What this turn handed the model, written down as it is assembled and saved
  // once the answer has already been delivered. Accumulating is pure assignment
  // — no I/O, nothing awaited — so nothing here is on the path of the reply.
  // See packages/agent-tools/src/turn-context.
  const recorder = new TurnContextRecorder({
    organizationId: user.organization.id,
    conversationId,
    userId: user.id,
    agentId: agent.id,
    model: agent.defaultModel,
    logger,
  });
  // The retrieval as it really came back, near-misses included. It can only be
  // taken from inside the search that ran: kb.search drops everything below the
  // floor before returning, and running a second search later would answer a
  // different question with today's thresholds. See ToolContext.onRetrieval.
  let retrievalSeen: RetrievalObservation | null = null;

  const ctx = buildToolContext({
    organizationId: user.organization.id,
    userId: user.id,
    agentId: agent.id,
    conversationId,
    onRetrieval: (observation) => {
      retrievalSeen = observation;
    },
  });

  // RAG prepend: kb.search top 3 on the last user message (conditional).
  // Skipped entirely while the KB has no indexed chunks — saves an embedding
  // round-trip per message on fresh workspaces.
  const ragQuery = lastUserMessage?.content ?? '';
  let ragBlock = '';
  // "Does this workspace know anything yet?" — counted on kb_documents rather
  // than kb_chunks. Two reasons, and the second is the real one: chunks have no
  // organization_id (they inherit it from their document, see migration 0064
  // § 12), so a count across every chunk in the install used to make a brand-new
  // company run retrieval because SOMEBODY ELSE had uploaded a file.
  //
  // The per-conversation adjustments ride along with the count that was already
  // being awaited here. Concurrent on purpose: it is one indexed lookup by
  // primary key and it hides entirely behind a query the turn was making
  // anyway, so the knobs cost the chat no wall-clock at all. `loadOverrides`
  // never throws — a diagnostics setting that fails to load costs the default
  // behaviour, never the answer.
  const [{ count: chunkCount }, overrides] = await Promise.all([
    db.from('kb_documents').select('id', { count: 'exact', head: true }),
    loadOverrides(db, conversationId),
  ]);
  recorder.adjusted(hasOverrides(overrides));
  const fragmentLimit = overrides.fragmentLimit ?? DEFAULT_FRAGMENTS;
  if ((chunkCount ?? 0) === 0) {
    recorder.retrievalSkipped('Todavía no hay nada indexado en Brain Knowledge.', fragmentLimit);
  } else if (fragmentLimit === 0) {
    recorder.retrievalSkipped(
      'Alguien puso en cero los fragmentos para esta conversación.',
      fragmentLimit,
    );
  } else if (!shouldRunRag(ragQuery)) {
    recorder.retrievalSkipped(
      'El mensaje es muy corto o es un acuse de recibo, así que no valía la pena buscar.',
      fragmentLimit,
    );
  }
  if ((chunkCount ?? 0) > 0 && fragmentLimit > 0 && shouldRunRag(ragQuery)) {
    // The relevance cut used to live here, as `score >= 0.65` on the blended
    // rank — a number that could not be interpreted and that, measured against
    // a real corpus, never got there at all: semantic matching alone tops out
    // around 0.49, so this block was discarding every correct result it was
    // ever handed. kb.search now applies the cut on cosine similarity, where a
    // threshold means something, and reports what it concluded in `coverage`.
    // See packages/agent-tools/src/kb/relevance.ts for the measurement.
    const ragOut = ragQuery
      ? await runTool(
          kbSearch,
          { query: ragQuery, limit: fragmentLimit },
          // A conversation-scoped narrowing, passed the same way the abort
          // signal is below. It can only ever restrict: Postgres intersects it
          // with what this person can already see, so an id for somebody else's
          // space contributes nothing. Spread conditionally because `undefined`
          // means "no restriction" while `[]` would mean "no space at all".
          overrides.spaceIds ? { ...ctx, kbSpaceIds: overrides.spaceIds } : ctx,
        ).catch(() => null)
      : null;

    if (ragOut && ragOut.coverage === 'nothing') {
      // The empty case is now stated instead of skipped. An absent <context>
      // block is indistinguishable from "RAG did not run", so the model used to
      // answer from nothing with no idea it was doing so; being told, in words,
      // that the brain holds nothing on the subject is what lets it say so.
      ragBlock = `<context>\n${ragOut.summary}\n</context>`;
    } else if (ragOut && ragOut.hits.length > 0) {
      ragBlock =
        '<context>\n' +
        `${ragOut.summary}\n\n` +
        ragOut.hits
          .map(
            (h, i) =>
              // A chunk of a recording is located by its offset, not by a chunk
              // number, and its text already opens with the speaker — so this
              // reads "[12:34] Ana: …" and can be quoted straight back. The age
              // and the "coincidencia débil" marker travel with the citation
              // because they change what it is worth: a rate from a year ago is
              // a different claim from the same rate quoted last week.
              `[^${i + 1}] ${h.documentTitle} ${h.spokenAt ? `at ${h.spokenAt}` : `chunk ${h.chunkIndex}`}` +
              `${h.age ? ` · ${h.age}` : ''}${h.relevance === 'weak' ? ' · coincidencia débil' : ''}:\n` +
              `${h.spokenAt ? `[${h.spokenAt}] ` : ''}${h.content}`,
          )
          .join('\n\n') +
        (ragOut.conflicts && ragOut.conflicts.length > 0
          ? `\n\n${ragOut.conflicts.map((c) => `⚠ CONFLICTO: ${c.note}`).join('\n')}`
          : '') +
        '\n</context>';
    }

    // Written down from the block that was just built, not from the scores.
    // `ragOut.hits` IS what got pasted above the question — anything the floor
    // dropped never appears in it — so this set is the ground truth for which
    // fragments the model really saw, and `retrievalSeen` supplies the ones it
    // did not. Neither is re-derived: see ToolContext.onRetrieval.
    if (retrievalSeen) {
      const prepended = new Set(
        ragBlock && ragOut ? ragOut.hits.map((h) => fragmentKey(h.documentId, h.chunkIndex)) : [],
      );
      recorder.retrieved(retrievalSeen, prepended);
    } else if (!ragOut) {
      recorder.retrievalSkipped('La búsqueda en Brain Knowledge falló en este turno.', fragmentLimit);
    }
  }

  const recentText = messages
    .filter((m) => m.role === 'user')
    .slice(-4)
    .map((m) => m.content)
    .join('\n');

  // Team tool permissions are a deny-list layered on the agent's tools:
  // anything blocked by ANY of the user's teams never reaches the model. Run
  // alongside the external-MCP fetch — neither depends on the other, and both
  // have to finish before anything can be ranked.
  //
  // Per-user MCP failures must never break the turn, so that fetch is
  // best-effort.
  const [deniedPatterns, externalServers, customRows] = await Promise.all([
    deniedToolPatterns(db, user.id),
    fetchEnabledExternalTools(db, user.id).catch(() => []),
    fetchEnabledCustomTools(db).catch(() => []),
  ]);

  const registryCandidates: Candidate[] = filterTools(agent.allowedTools)
    .filter((t) => deniedPatterns.length === 0 || !isToolDenied(t.id, deniedPatterns))
    .map((t) => ({
      id: t.id,
      family: t.id.split('.')[0] ?? t.id,
      description: t.description,
      kind: 'registry' as const,
      ref: t,
    }));

  // The workspace's own tools (migration 0067). They are `kind: 'registry'`
  // candidates on purpose: a custom tool IS an ordinary ToolDef by the time it
  // gets here, so it takes the same execute path below and therefore the same
  // runTool guarantees — audit, confirmation, rate limit, risk classification.
  // The only thing that differs is where the definition came from.
  //
  // They pass through the identical access gates: the agent's grant patterns
  // (`toolIdAllowed`, the same matcher `filterTools` uses on the registry) and
  // the team deny-list. A tool a company wrote for itself is not exempt from
  // the permissions that company configured.
  //
  // One family for all of them, not one per tool. Ranking promotes whole
  // families (see tool-selection/rank.ts), and one custom tool proving relevant
  // pulling in the handful of others costs a few declarations — while a family
  // per tool would compete for the six situational slots against gmail, kb and
  // the rest, and start pushing real families out on vague requests.
  const customCandidates: Candidate[] = customRows
    .map((row) => customToolDef(row))
    .filter(
      (t) =>
        toolIdAllowed(agent.allowedTools, t.id) &&
        (deniedPatterns.length === 0 || !isToolDenied(t.id, deniedPatterns)),
    )
    .map((t) => ({
      id: t.id,
      family: CUSTOM_TOOL_FAMILY,
      description: t.description,
      kind: 'registry' as const,
      ref: t as AnyTool,
    }));

  const externalCandidates: Candidate[] = externalServers.flatMap(({ server, tools }) =>
    tools.map((entry) => ({
      // Namespaced by server so two servers exposing `search` stay distinct,
      // and stable across turns so the stored vector keeps matching.
      id: `mcp:${server.id}:${entry.tool_name}`,
      // One connected server is one family: its tools were designed to be used
      // together, exactly like `hubspot` was.
      family: `mcp:${server.id}`,
      description: entry.tool_description ?? '',
      kind: 'external' as const,
      ref: { server, entry },
    })),
  );

  // Semantic scoping. This replaced a hand-written regex per family, which was
  // wrong the moment anyone shipped a family or connected an MCP server without
  // editing this file — see packages/agent-tools/src/tool-selection. Everything
  // it can fail on (Voyage, the vector table, an unindexed tool) degrades to
  // sending MORE tools, never fewer.
  const allCandidates = [...registryCandidates, ...customCandidates, ...externalCandidates];
  const selection = await selectToolsForTurn({
    db,
    tools: allCandidates,
    query: recentText,
  });
  // A conversation may withhold a whole family. Applied AFTER ranking rather
  // than by removing candidates before it, so the capture can still show what
  // the muted family would have scored — "you turned this off and it was the
  // best match" is the thing somebody needs to see to undo the decision. It
  // only ever removes: nothing here can offer a tool the agent's grants and the
  // team deny-list did not already allow.
  const mutedFamilies = new Set(overrides.mutedFamilies);
  const selectedTools =
    mutedFamilies.size === 0
      ? selection.tools
      : selection.tools.filter((t) => !mutedFamilies.has(t.family));
  logger.debug('chat tool selection', {
    reason: selection.reason,
    offered: selectedTools.length,
    of: allCandidates.length,
    families: selection.selectedFamilies,
    unranked: selection.unrankedFamilies,
  });

  // The ranking as it happened. It cannot be recovered afterwards even in
  // principle — the query vector is not kept and a tool's vector is re-embedded
  // the moment somebody edits its description — so it is written down here or
  // it is lost. `offered` is read off the declarations actually built, below,
  // rather than from this list, so the record is of what the model saw.
  recorder.toolOffer({
    reason: selection.reason,
    candidates: allCandidates.length,
    offered: selectedTools.map((t) => t.id),
    families: familiesFrom({
      scores: selection.familyScores,
      alwaysFamilies: selection.alwaysFamilies,
      selected: selection.selectedFamilies,
      unranked: selection.unrankedFamilies,
      muted: overrides.mutedFamilies,
    }),
  });

  const aiTools: Record<string, CoreTool> = {};
  for (const candidate of selectedTools) {
    if (candidate.kind === 'registry') {
      const t = candidate.ref;
      // AI SDK requires tool names matching ^[a-zA-Z0-9_-]+$ — replace dots with underscores
      aiTools[t.id.replaceAll('.', '_')] = tool({
        description: t.description,
        parameters: t.inputSchema,
        execute: async (args, { abortSignal }) => {
          try {
            return await runTool(t, args, { ...ctx, signal: abortSignal });
          } catch (err) {
            if (err instanceof ConfirmationRequiredError) {
              // Return a sentinel value the client can detect to show a confirmation prompt
              return {
                __requires_confirmation: true,
                toolId: t.id,
                input: err.input,
              } as unknown as never;
            }
            // Never throw: a failed tool must not kill the turn. Return a
            // structured error so (a) the model can read it, explain it, and
            // keep going, and (b) the UI renders it as a failed tool card.
            return {
              __error: true,
              tool: t.id,
              message: toToolErrorMessage(err),
            } as unknown as never;
          }
        },
      });
      continue;
    }

    const { server, entry } = candidate.ref;
    const prefix = 'mcp_' + server.id.replace(/-/g, '').slice(0, 16) + '_';
    const sdkName = (prefix + entry.tool_name).slice(0, 64);
    aiTools[sdkName] = tool({
      description: (entry.tool_description ?? '').slice(0, 500),
      parameters: jsonSchema(
        (entry.input_schema_json ?? {
          type: 'object',
          properties: {},
        }) as Parameters<typeof jsonSchema>[0],
      ),
      execute: async (args, { abortSignal }) => {
        if (!server.trusted) {
          return {
            __requires_confirmation: true,
            toolId: sdkName,
            input: args,
          } as unknown as never;
        }
        try {
          return await callExternalTool(
            server as unknown as ExternalServerRow,
            entry.tool_name,
            args,
            {
              userId: user.id,
              db,
              signal: abortSignal,
            },
          );
        } catch (err) {
          return {
            __error: true,
            tool: `${server.name}/${entry.tool_name}`,
            message: toToolErrorMessage(err),
          } as unknown as never;
        }
      },
    });
  }

  let coreMessages: CoreMessage[] = messages.map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }));

  if (conversationId) {
    try {
      const { data: dbMessages } = await db
        .from('messages')
        .select('role, content')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (dbMessages && dbMessages.length > 0) {
        const dbSet = new Set(dbMessages.map((m) => `${m.role}::${m.content}`));
        const clientOnly = coreMessages.filter(
          (m) => !dbSet.has(`${m.role}::${String(m.content)}`),
        );
        coreMessages = [
          ...dbMessages.reverse().map((m) => ({
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content as string,
          })),
          ...clientOnly,
        ];
      }
    } catch (err) {
      // non-fatal, use client messages
    }
  }

  // Shared with Google Chat and MCP so a person's standing instructions cannot
  // apply on one surface and silently not on another. See lib/system-prompt.ts.
  const { system, memories, memoryBlock } = await buildSystemPrompt({
    organizationId: user.organization.id,
    userId: user.id,
    basePrompt: agent.systemPrompt,
    sections: [ragBlock],
  });

  // Weigh the turn from the strings that were really concatenated — every one
  // of these is the exact text that went into the request, so `chars` is a
  // measurement and not a guess. (Tokens are derived from it and are labelled
  // as an estimate on screen; the provider's true count is recorded below.)
  //
  // The tool part is measured as the ids and descriptions the model reads. The
  // JSON envelope around them is not counted, because serialising every
  // parameter schema per turn is real work on the hot path for a number the
  // descriptions already dominate — a catalogue's descriptions run to hundreds
  // of characters each. The page says so rather than implying the breakdown is
  // the whole request.
  recorder.basePrompt(agent.systemPrompt);
  recorder.memory(memories.map((m) => ({ id: m.id, text: m.content })));
  recorder.part('instructions', agent.systemPrompt);
  recorder.part('memory', memoryBlock);
  recorder.part('knowledge', ragBlock);
  recorder.part('tools', selectedTools.map((t) => `${t.id}: ${t.description}`).join('\n'));
  // Split at the last message rather than by role, so the two parts are exactly
  // the array that was sent and cannot double-count a single character.
  recorder.part('history', coreMessages.slice(0, -1).map((m) => String(m.content)).join('\n'));
  recorder.part('question', String(coreMessages[coreMessages.length - 1]?.content ?? ''));

  const result = streamText({
    model: chatModel(agent.defaultModel),
    system,
    messages: coreMessages,
    tools: aiTools,
    toolChoice: 'auto',
    maxSteps: 12,
    onFinish: async ({ text, toolCalls, toolResults, usage }) => {
      let assistantMessageId: string | null = null;
      try {
        const { data: assistantRow } = await db
          .from('messages')
          .insert({
            conversation_id: conversationId,
            role: 'assistant',
            content: text,
            tool_calls: toolCalls as unknown as object,
            tool_results: toolResults as unknown as object,
          })
          .select('id')
          .single();
        assistantMessageId = (assistantRow?.id as string | undefined) ?? null;
        // Auto-generate title on first turn
        const isFirstTurn = coreMessages.filter((m) => m.role === 'assistant').length <= 1;
        if (isFirstTurn && lastUserMessage) {
          void (async () => {
            try {
              const { text: titleText } = await generateText({
                model: utilityModel(),
                prompt: `Summarize this sales conversation starter in 5 words or fewer, no punctuation: "${lastUserMessage.content.slice(0, 200)}"`,
                // Thinking off + real headroom: Claude counts reasoning against
                // maxTokens, so the old 20-token cap would truncate before the
                // title itself was ever emitted.
                providerOptions: NO_THINKING,
                maxTokens: 256,
              });
              await db
                .from('conversations')
                .update({ title: titleText.trim() })
                .eq('id', conversationId);
            } catch {
              /* non-fatal */
            }
          })();
        }
        await db.from('audit_events').insert({
          user_id: user.id,
          agent_id: agent.id,
          conversation_id: conversationId,
          tool_id: '__agent_turn',
          input_hash: 'turn',
          status: 'ok',
          latency_ms: 0,
          metadata: {
            model: agent.defaultModel,
            tokensIn: usage?.promptTokens ?? 0,
            tokensOut: usage?.completionTokens ?? 0,
          },
        });
      } catch {
        // Non-fatal: don't kill the stream if persistence fails
      }

      // The turn's context, written after the last token has already reached
      // the person. Outside the try above on purpose: a turn whose message
      // failed to persist is exactly the turn somebody will want to inspect, so
      // the capture must not be skipped by the same failure. `save` swallows
      // its own errors and is awaited only so the serverless invocation is not
      // frozen mid-write — nobody is waiting on it, the response is finished.
      await recorder.save(db, {
        messageId: assistantMessageId,
        usage: {
          promptTokens: usage?.promptTokens,
          completionTokens: usage?.completionTokens,
        },
      });
    },
  });

  return result.toDataStreamResponse({
    headers: { 'X-Conversation-Id': conversationId },
    // Send the model's reasoning to the client. Opus 5 thinks before it writes,
    // and on a turn that calls tools that thinking is the only account of why it
    // chose them — without it the user watches a long silence and then a result,
    // with no way to judge whether the route taken was sensible.
    sendReasoning: true,
    // An error part on the data stream makes useChat drop the assistant message
    // it was building, so a hiccup the model itself recovered from wiped the
    // whole answer from the screen — the reply was in the database and only
    // reappeared on reload. Surfacing the real reason turns a silent
    // "An error occurred." into something both the user and we can act on.
    getErrorMessage: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('chat stream error', { message });
      return message.slice(0, 300);
    },
  });
}
