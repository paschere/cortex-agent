import { ChatRoot } from '@/components/chat/ChatRoot';
import { listAgents } from '@zipdev/agents';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
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
    .map((m) => ({
      id: m.id as string,
      role: m.role as 'user' | 'assistant',
      content: (m.content as string) ?? '',
    }));

  return (
    <ChatRoot
      agents={agents}
      conversationId={conversationId}
      initialMessages={initialMessages}
    />
  );
}
