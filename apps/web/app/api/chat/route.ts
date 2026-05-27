import { NextResponse, type NextRequest } from 'next/server';
import { google } from '@ai-sdk/google';
import { streamText, tool, type CoreMessage } from 'ai';
import { z } from 'zod';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { buildToolContext } from '@/lib/agent';
import { loadAgent } from '@zipdev/agents';
import { filterTools, runTool, kbSearch } from '@zipdev/agent-tools';
import { ConfirmationRequiredError } from '@zipdev/core';

export const runtime = 'nodejs';
export const maxDuration = 300;

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

  // RAG prepend: kb.search top 5 on the last user message
  const ragQuery = lastUserMessage?.content ?? '';
  const ragOut = ragQuery
    ? await runTool(kbSearch, { query: ragQuery, limit: 5 }, ctx).catch(() => ({
        hits: [] as Array<{ documentTitle: string; chunkIndex: number; content: string }>,
      }))
    : { hits: [] as Array<{ documentTitle: string; chunkIndex: number; content: string }> };

  const ragBlock =
    ragOut.hits.length > 0
      ? `<context>\n${ragOut.hits
          .map((h, i) => `[${i + 1}] ${h.documentTitle} (chunk ${h.chunkIndex}):\n${h.content}`)
          .join('\n\n')}\n</context>`
      : '';

  const allowed = filterTools(agent.allowedTools);

  // AI SDK requires tool names matching ^[a-zA-Z0-9_-]+$ — replace dots with underscores
  // Build reverse map to find original tool by its AI SDK name
  const toolNameToId = new Map<string, string>();
  const aiTools = Object.fromEntries(
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

  const coreMessages: CoreMessage[] = messages.map((m) => ({
    role: m.role as 'user' | 'assistant' | 'system',
    content: m.content,
  }));

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
