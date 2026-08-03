import { ChatRoot } from '@/components/chat/ChatRoot';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { toToolInvocations } from '@/lib/tool-invocations';
import { listAgents } from '@cortex/agents';
import type { Message } from 'ai';

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

  // Verify conversation ownership (and recover its agent so a resumed chat
  // stays on the same agent instead of defaulting to the first in the list).
  const { data: conv } = await db
    .from('conversations')
    .select('id, agents(slug)')
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
      const toolInvocations = toToolInvocations(m.tool_calls, m.tool_results);
      return {
        id: m.id as string,
        role: m.role as 'user' | 'assistant',
        content: (m.content as string) ?? '',
        ...(toolInvocations ? { toolInvocations } : {}),
      };
    });

  const convAgents = conv.agents as { slug: string } | { slug: string }[] | null;
  const convAgentSlug = Array.isArray(convAgents) ? convAgents[0]?.slug : convAgents?.slug;

  return (
    <ChatRoot
      agents={agents}
      conversationId={conversationId}
      initialMessages={initialMessages}
      initialAgentSlug={convAgentSlug}
    />
  );
}
