import { ChatRoot } from '@/components/chat/ChatRoot';
import { listAgents } from '@zipdev/agents';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import type { Message, ToolInvocation } from 'ai';

// Convert DB-persisted tool_calls / tool_results into AI SDK toolInvocations
// so resumed conversations render ToolCallCards instead of dropping them.
function buildToolInvocations(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolCalls: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  toolResults: any[],
): ToolInvocation[] | undefined {
  if (!toolCalls?.length) return undefined;
  const resultMap = new Map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (toolResults ?? []).map((r: any) => [r.toolCallId, r.result]),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return toolCalls.map((tc: any) => ({
    toolCallId: tc.toolCallId,
    toolName: tc.toolName,
    args: tc.args,
    state: resultMap.has(tc.toolCallId) ? ('result' as const) : ('call' as const),
    result: resultMap.get(tc.toolCallId),
  })) as ToolInvocation[];
}

export default async function ResumeChatPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  const agents = listAgents().map((a) => ({
    slug: a.id,
    name: a.name,
    greeting: a.greeting,
  }));

  // Load messages from DB — only user/assistant roles for useChat
  const { data: msgs } = await db
    .from('messages')
    .select('id, role, content, tool_calls, tool_results, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  // Verify conversation ownership
  const { data: conv } = await db
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .maybeSingle();

  if (!conv) {
    // conversation not found or not owned — render a fresh chat
    return <ChatRoot agents={agents} />;
  }

  // Map DB rows to AI SDK Message shape; skip 'tool' role (internal)
  const initialMessages: Message[] = (msgs ?? [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolCalls = (m.tool_calls as any[]) ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolResults = (m.tool_results as any[]) ?? [];
      const toolInvocations = toolCalls.length
        ? buildToolInvocations(toolCalls, toolResults)
        : undefined;
      return {
        id: m.id as string,
        role: m.role as 'user' | 'assistant',
        content: (m.content as string) ?? '',
        ...(toolInvocations ? { toolInvocations } : {}),
      };
    });

  return (
    <ChatRoot
      agents={agents}
      conversationId={conversationId}
      initialMessages={initialMessages}
    />
  );
}
