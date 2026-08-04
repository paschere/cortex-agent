'use client';

import type { Message } from 'ai';
import { useChat } from 'ai/react';
import { Menu, Stamp } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useGlobalHotkeys } from '../../hooks/useGlobalHotkeys';
import { useMobileSidebar } from '../nav/MobileSidebarContext';
import { CommandPalette } from './CommandPalette';
import { InputBar } from './InputBar';
import { MessageList } from './MessageList';

interface AgentInfo {
  slug: string;
  name: string;
  greeting: string;
}

interface ChatRootProps {
  agents: AgentInfo[];
  conversationId?: string;
  initialMessages?: Message[];
  /** Agent of a resumed conversation — keeps it pinned instead of defaulting to agents[0]. */
  initialAgentSlug?: string;
}

export function ChatRoot({
  agents,
  conversationId: initialConvId,
  initialMessages,
  initialAgentSlug,
}: ChatRootProps) {
  const [agentSlug, setAgentSlug] = useState(initialAgentSlug ?? agents[0]?.slug ?? 'cortex');
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

  const handleSend = useCallback(
    (text: string) => void append({ role: 'user', content: text }),
    [append],
  );

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
      <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          aria-label="Abrir menú"
          className="rounded-card p-1.5 text-ink-muted hover:bg-surface-2 md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-card border border-primary/30 bg-primary-soft text-primary">
            <Stamp className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold text-ink">
              {activeAgent?.name ?? 'Cortex'}
            </div>
            {/* The conversation id is what a person quotes when they need this
                exchange looked up later, so it is set as evidence, not prose. */}
            <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
              {conversationId ? (
                <span title={conversationId}>#{conversationId.slice(0, 8)}</span>
              ) : (
                'Conversación nueva'
              )}
            </div>
          </div>
        </div>
      </header>

      <MessageList
        messages={messages}
        isLoading={isLoading}
        conversationId={conversationId}
        agent={activeAgent}
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
