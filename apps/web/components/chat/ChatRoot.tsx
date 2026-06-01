'use client';

import { useCallback, useMemo, useState } from 'react';
import { useChat } from 'ai/react';
import type { Message } from 'ai';
import { Menu, Sparkles } from 'lucide-react';
import { useGlobalHotkeys } from '../../hooks/useGlobalHotkeys';
import { useMobileSidebar } from '../nav/MobileSidebarContext';
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
  const [draft, setDraft] = useState('');
  const { setOpen: setSidebarOpen } = useMobileSidebar();

  const activeAgent = agents.find((a) => a.slug === agentSlug) ?? agents[0];

  const { messages, append, reload, isLoading, setMessages } = useChat({
    api: '/api/chat',
    initialMessages: initialMessages ?? [],
    body: { agentSlug, conversationId },
    experimental_prepareRequestBody: (options) => {
      const normalizedMessages = options.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
        .map((m) => ({
          role: m.role as 'user' | 'assistant' | 'system',
          content: typeof m.content === 'string' ? m.content : '',
        }))
        .filter((m) => m.content.length > 0 || m.role !== 'assistant');
      const body: Record<string, unknown> = { agentSlug, messages: normalizedMessages };
      if (conversationId) body.conversationId = conversationId;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return body as any;
    },
    onResponse: (response) => {
      const newConvId = response.headers.get('X-Conversation-Id');
      if (newConvId && newConvId !== conversationId) {
        setConversationId(newConvId);
        // Update the URL WITHOUT a Next.js navigation. router.replace() would
        // remount the [conversationId] route and reload initialMessages from the
        // DB mid-stream — wiping the messages until a manual reload. history API
        // changes the address bar while keeping the live useChat state intact.
        window.history.replaceState(null, '', `/chat/${newConvId}`);
      }
    },
    sendExtraMessageFields: false,
  });

  const handleSend = useCallback((text: string) => void append({ role: 'user', content: text }), [append]);

  const hotkeys = useMemo(
    () => ({
      'mod+k': () => setPaletteOpen((v) => !v),
      escape: () => setPaletteOpen(false),
    }),
    [],
  );
  useGlobalHotkeys(hotkeys);

  const handleRegenerate = useCallback(() => void reload(), [reload]);
  const handleAgentChange = useCallback(
    (slug: string) => {
      setAgentSlug(slug);
      setMessages([]);
    },
    [setMessages],
  );

  return (
    <div className="flex h-full flex-col bg-canvas">
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur-md">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open menu"
          className="rounded-[10px] p-1.5 text-ink-muted hover:bg-surface-2 md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-gradient-to-br from-primary to-primary-strong text-white">
            <Sparkles className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <div className="text-sm font-bold text-ink">{activeAgent?.name ?? 'Chat'}</div>
            <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald" />
              {conversationId ? 'Conversation' : 'New chat'}
            </div>
          </div>
        </div>
      </header>

      <MessageList
        messages={messages}
        isLoading={isLoading}
        conversationId={conversationId}
        onConfirmed={reload}
        onRegenerate={handleRegenerate}
        onSuggestion={setDraft}
      />

      <InputBar
        onSend={handleSend}
        disabled={isLoading}
        conversationId={conversationId}
        agents={agents}
        agentSlug={agentSlug}
        onAgentChange={handleAgentChange}
        draft={draft}
        onDraftConsumed={() => setDraft('')}
      />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
