'use client';

import { useCallback, useMemo, useState } from 'react';
import { useChat } from 'ai/react';
import type { Message } from 'ai';
import { useRouter } from 'next/navigation';
import { useGlobalHotkeys } from '../../hooks/useGlobalHotkeys';
import { MessageList } from './MessageList';
import { InputBar } from './InputBar';
import { CommandPalette } from './CommandPalette';

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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const router = useRouter();

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

  const hotkeys = useMemo(
    () => ({
      'mod+k': () => setPaletteOpen((v) => !v),
      escape: () => setPaletteOpen(false),
    }),
    [],
  );
  useGlobalHotkeys(hotkeys);

  const handleRegenerate = useCallback(() => {
    void reload();
  }, [reload]);

  const handleAgentChange = useCallback((slug: string) => {
    setAgentSlug(slug);
    setMessages([]);
  }, [setMessages]);

  return (
    <div className="flex flex-col h-full max-w-3xl mx-auto w-full">
      <header className="border-b px-4 py-3 flex items-center justify-between text-sm shrink-0">
        <span className="font-semibold text-neutral-700 dark:text-neutral-300">
          {initialConvId ? 'Conversation' : 'New Chat'}
        </span>
      </header>
      <MessageList
        messages={messages}
        isLoading={isLoading}
        conversationId={conversationId}
        onConfirmed={reload}
        onRegenerate={handleRegenerate}
      />
      <InputBar
        onSend={handleSend}
        disabled={isLoading}
        conversationId={conversationId}
        agents={agents}
        agentSlug={agentSlug}
        onAgentChange={handleAgentChange}
      />
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
