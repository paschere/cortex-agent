'use client';

import { useState } from 'react';
import { useChat } from 'ai/react';
import type { Message } from 'ai';
import { useRouter } from 'next/navigation';
import { Menu } from 'lucide-react';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { useMobileSidebar } from '@/components/nav/MobileSidebarContext';

interface AgentInfo {
  slug: string;
  name: string;
  greeting: string;
}

interface ChatRootProps {
  agents: AgentInfo[];
  conversationId?: string;
  initialMessages?: Message[];
}

export function ChatRoot({ agents, conversationId: initialConvId, initialMessages }: ChatRootProps) {
  const [agentSlug, setAgentSlug] = useState(agents[0]?.slug ?? 'sales');
  const [conversationId, setConversationId] = useState<string | undefined>(initialConvId);
  const router = useRouter();
  const { setOpen: setSidebarOpen } = useMobileSidebar();

  const { messages, append, reload, isLoading, setMessages } = useChat({
    api: '/api/chat',
    initialMessages: initialMessages ?? [],
    body: {
      agentSlug,
      conversationId,
    },
    // Use experimental_prepareRequestBody to always include latest conversationId
    // and normalize messages to the shape expected by /api/chat
    experimental_prepareRequestBody: (options) => {
      const normalizedMessages = options.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
        .map((m) => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: typeof m.content === 'string' ? m.content : '',
        }))
        .filter((m) => m.content.length > 0 || m.role !== 'assistant');
      const body: Record<string, unknown> = {
        agentSlug,
        messages: normalizedMessages,
      };
      if (conversationId) {
        body.conversationId = conversationId;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return body as any;
    },
    onResponse: (response) => {
      const newConvId = response.headers.get('X-Conversation-Id');
      if (newConvId && newConvId !== conversationId) {
        setConversationId(newConvId);
        router.replace(`/chat/${newConvId}`);
      }
    },
    sendExtraMessageFields: false,
  });

  async function handleSend(text: string) {
    await append({ role: 'user', content: text });
  }

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto w-full">
      <header className="border-b px-4 py-3 flex items-center justify-between text-sm shrink-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="md:hidden rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            <Menu className="h-4 w-4" />
          </button>
          <span className="font-semibold text-neutral-700 dark:text-neutral-300">
            {initialConvId ? 'Conversation' : 'New Chat'}
          </span>
        </div>
        <select
          value={agentSlug}
          onChange={(e) => {
            setAgentSlug(e.target.value);
            setMessages([]);
          }}
          disabled={!!conversationId}
          className="bg-transparent border rounded px-2 py-1 text-xs"
        >
          {agents.map((a) => (
            <option key={a.slug} value={a.slug}>
              {a.name}
            </option>
          ))}
        </select>
      </header>
      <MessageList messages={messages} isLoading={isLoading} conversationId={conversationId} onConfirmed={reload} />
      <InputBar onSend={handleSend} disabled={isLoading} conversationId={conversationId} />
    </div>
  );
}
