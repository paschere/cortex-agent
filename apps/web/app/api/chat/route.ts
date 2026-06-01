import { NextResponse, type NextRequest } from 'next/server';
import { google } from '@ai-sdk/google';
import { streamText, generateText, tool, jsonSchema, type CoreMessage, type CoreTool } from 'ai';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { buildToolContext } from '@/lib/agent';
import { loadAgent } from '@zipdev/agents';
import {
  filterTools,
  runTool,
  kbSearch,
  fetchEnabledExternalTools,
  callExternalTool,
  type ExternalServerRow,
} from '@zipdev/agent-tools';
import { ConfirmationRequiredError } from '@zipdev/core';

export const runtime = 'nodejs';
export const maxDuration = 300;

const ACKNOWLEDGMENT_RE = /^(ok|yes|no|sure|thanks|got it|sounds good|proceed|continue|sí|claro|dale|perfecto|de acuerdo)[.!?]?$/i

function shouldRunRag(message: string): boolean {
  const wordCount = message.trim().split(/\s+/).length
  if (wordCount < 8) return false
  if (ACKNOWLEDGMENT_RE.test(message.trim())) return false
  return true
}

const MessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
});

const Body = z.object({
  agentSlug: z.string().default('sales'),
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

  const db = getSupabaseServiceClient();

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

  const ctx = buildToolContext({ userId: user.id, agentId: agent.id, conversationId });

  // RAG prepend: kb.search top 3 on the last user message (conditional)
  const ragQuery = lastUserMessage?.content ?? '';
  let ragBlock = ''
  if (shouldRunRag(ragQuery)) {
    const ragOut = ragQuery ? await runTool(kbSearch, { query: ragQuery, limit: 3 }, ctx).catch(() => ({ hits: [] })) : { hits: [] }
    const relevant = (ragOut.hits as Array<{score?: number; documentTitle: string; chunkIndex: number; content: string}>).filter(h => (h.score ?? 1) >= 0.65)
    if (relevant.length > 0) {
      ragBlock = '<context>\n' + relevant.map((h, i) => `[^${i+1}] (${(h.score ?? 0).toFixed(2)}) ${h.documentTitle} chunk ${h.chunkIndex}:\n${h.content}`).join('\n\n') + '\n</context>'
    }
  }

  const allowed = filterTools(agent.allowedTools);

  // AI SDK requires tool names matching ^[a-zA-Z0-9_-]+$ — replace dots with underscores
  // Build reverse map to find original tool by its AI SDK name
  const toolNameToId = new Map<string, string>();
  const aiTools: Record<string, CoreTool> = Object.fromEntries(
    allowed.map((t) => {
      const sdkName = t.id.replaceAll('.', '_');
      toolNameToId.set(sdkName, t.id);
      return [
        sdkName,
        tool({
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
              throw err;
            }
          },
        }),
      ];
    }),
  );

  // Inject per-user external (dynamic) MCP tools. Failures here must never
  // break the chat turn, so the whole fetch is best-effort.
  const externalServers = await fetchEnabledExternalTools(db, user.id).catch(() => []);
  for (const { server, tools } of externalServers) {
    for (const t of tools) {
      const prefix = 'mcp_' + server.id.replace(/-/g, '').slice(0, 16) + '_';
      const sdkName = (prefix + t.tool_name).slice(0, 64);
      aiTools[sdkName] = tool({
        description: (t.tool_description ?? '').slice(0, 500),
        parameters: jsonSchema((t.input_schema_json ?? { type: 'object', properties: {} }) as Parameters<typeof jsonSchema>[0]),
        execute: async (args, { abortSignal }) => {
          if (!server.trusted) {
            return { __requires_confirmation: true, toolId: sdkName, input: args } as unknown as never;
          }
          return callExternalTool(server as unknown as ExternalServerRow, t.tool_name, args, {
            userId: user.id,
            db,
            signal: abortSignal,
          });
        },
      });
    }
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
        .limit(20)
      if (dbMessages && dbMessages.length > 0) {
        const dbSet = new Set(dbMessages.map(m => `${m.role}::${m.content}`))
        const clientOnly = coreMessages.filter(m => !dbSet.has(`${m.role}::${String(m.content)}`))
        coreMessages = [
          ...dbMessages.reverse().map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content as string })),
          ...clientOnly,
        ]
      }
    } catch (err) {
      // non-fatal, use client messages
    }
  }

  const result = streamText({
    model: google(agent.defaultModel),
    system: agent.systemPrompt + (ragBlock ? `\n\n${ragBlock}` : ''),
    messages: coreMessages,
    tools: aiTools,
    maxSteps: 8,
    onFinish: async ({ text, toolCalls, toolResults, usage }) => {
      try {
        await db.from('messages').insert({
          conversation_id: conversationId,
          role: 'assistant',
          content: text,
          tool_calls: toolCalls as unknown as object,
          tool_results: toolResults as unknown as object,
        });
        // Auto-generate title on first turn
        const isFirstTurn = coreMessages.filter(m => m.role === 'assistant').length <= 1
        if (isFirstTurn && lastUserMessage) {
          void (async () => {
            try {
              const { text: titleText } = await generateText({
                model: google('gemini-2.0-flash'),
                prompt: `Summarize this sales conversation starter in 5 words or fewer, no punctuation: "${lastUserMessage.content.slice(0, 200)}"`,
                maxTokens: 20,
              })
              await db.from('conversations').update({ title: titleText.trim() }).eq('id', conversationId)
            } catch { /* non-fatal */ }
          })()
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
    },
  });

  return result.toDataStreamResponse({
    headers: { 'X-Conversation-Id': conversationId },
  });
}
