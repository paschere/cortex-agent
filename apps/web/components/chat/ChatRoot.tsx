'use client';

import { type ScopeSpace, setChatScopeAction } from '@/app/(chat)/chat/actions';
import type { Message } from 'ai';
import { useChat } from 'ai/react';
import { clsx } from 'clsx';
import { Brain, Menu } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useRef, useState } from 'react';
import type { ScreenGlance } from '@/lib/tab-recorder';
import { useMobileSidebar } from '../nav/MobileSidebarContext';
import { InputBar } from './InputBar';
import { MessageList } from './MessageList';
import { useScreenView } from './ScreenView';

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
  /**
   * The spaces this conversation was already narrowed to, resolved to names by
   * the page. Empty means "everything this person can see", which is the
   * default and the state a brand-new chat always starts in.
   */
  initialScope?: ScopeSpace[];
  /**
   * Follow-ups saved with the answers of a resumed conversation, by message id.
   * They are generated once, when the answer is written, and read from then on
   * — see migration 0090. Absent on a brand-new chat, which has no answers yet.
   */
  initialFollowups?: Record<string, string[]>;
  /**
   * Which questions in a resumed conversation were asked with a look at the
   * person's shared tab, by message id, and when the picture was taken. Read
   * from `messages.screen_glance_at` — the image itself was never stored.
   */
  initialGlances?: Record<string, string>;
}

export function ChatRoot({
  agents,
  conversationId: initialConvId,
  initialMessages,
  initialAgentSlug,
  initialScope,
  initialFollowups,
  initialGlances,
}: ChatRootProps) {
  const [agentSlug, setAgentSlug] = useState(initialAgentSlug ?? agents[0]?.slug ?? 'cortex');
  const [conversationId, setConversationId] = useState<string | undefined>(initialConvId);
  const [draft, setDraft] = useState('');
  const [blocked, setBlocked] = useState<{ message: string; isLimit: boolean } | null>(null);
  const { setOpen: setSidebarOpen } = useMobileSidebar();

  /**
   * WHICH MEMORY ANSWERS, AND WHY IT TRAVELS TWO WAYS.
   *
   * The durable copy is `turn_context_settings.space_ids` on the conversation —
   * the column migration 0080 already made for this, and the same one the
   * diagnostics panel at /conversations/[id] edits. But a brand-new chat has no
   * conversation row yet, and the very first question is exactly the one
   * somebody wants to aim ("contéstame sólo con lo de aduanas"). So:
   *
   *   every turn        the selection rides in the request body, and /api/chat
   *                     uses it for THAT turn;
   *   once there is a   `setChatScopeAction` writes it down, so a reload, the
   *   conversation      diagnostics panel and the next turn all agree.
   *
   * The ref exists because `experimental_prepareRequestBody` below is handed to
   * `useChat` and must read the CURRENT selection, not the one that was in force
   * when the closure was made.
   */
  const [scope, setScope] = useState<ScopeSpace[]>(initialScope ?? []);
  const scopeRef = useRef<ScopeSpace[]>(initialScope ?? []);

  /**
   * THE SHARED TAB, AND WHEN IT IS ACTUALLY LOOKED AT.
   *
   * The session lives here rather than in the composer because the frame has to
   * reach the request body, and this is the component that builds it. The
   * composer only draws the control and the live strip.
   *
   * ONE FRAME PER QUESTION, TAKEN AT SEND. `handleSend` grabs it and parks it
   * in a ref that `experimental_prepareRequestBody` empties on the way out —
   * which is what makes `reload()` behave correctly for free: regenerating an
   * answer finds the ref empty and re-asks with the text alone, rather than
   * quietly photographing the screen again for a question the person did not
   * retype. A silent second capture is precisely the thing this feature must
   * never do.
   */
  const screen = useScreenView();
  const pendingGlance = useRef<ScreenGlance | null>(null);
  /** Which of THIS session's questions carried a picture, by message id. */
  const [glances, setGlances] = useState<Record<string, string>>({});

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
      // Only sent when there is one. An absent field is byte-identical to the
      // request this route has always received, so a chat with no filter is
      // exactly the chat it was before this existed.
      const scopeIds = scopeRef.current.map((s) => s.id);
      if (scopeIds.length > 0) body.spaceIds = scopeIds;
      // Taken a moment ago by `handleSend`, and consumed here so it can only
      // ever travel with the one question it was taken for.
      const glance = pendingGlance.current;
      pendingGlance.current = null;
      if (glance) body.screen = glance;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return body as any;
    },
    // A refused turn has to SAY so.
    //
    // `useChat` had no error handler at all, so a non-2xx reply — including the
    // 402 the plan gate returns — vanished: the composer re-enabled itself and
    // nothing appeared, which reads as "Cortex is broken", not as "you ran out".
    // A limit somebody cannot see is indistinguishable from a bug, and it is the
    // one moment where being clear costs us nothing and being vague costs the
    // account. The route puts a whole Spanish sentence in `error`; this pulls it
    // out and puts it on the screen with the way out.
    onError: (error) => {
      const raw = error instanceof Error ? error.message : String(error);
      try {
        const parsed = JSON.parse(raw) as { error?: string; reason?: string };
        if (parsed.error) {
          setBlocked({ message: parsed.error, isLimit: parsed.reason === 'plan_limit' });
          return;
        }
      } catch {
        // not JSON — fall through to the raw message
      }
      setBlocked({ message: raw.slice(0, 300), isLimit: false });
    },
    onResponse: (response) => {
      // Any successful send clears whatever the last failure said.
      setBlocked(null);
      const newConvId = response.headers.get('X-Conversation-Id');
      if (newConvId && newConvId !== conversationId) {
        setConversationId(newConvId);
        // The conversation exists now, so a filter chosen before the first
        // message finally has somewhere to live. Fire-and-forget: the turn it
        // applied to is already being answered with it, and a write that fails
        // costs a reload of the chip, never the answer.
        if (scopeRef.current.length > 0) {
          void setChatScopeAction(
            newConvId,
            scopeRef.current.map((s) => s.id),
          );
        }
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
    (text: string) => {
      // The picture is taken here, not on focus and not on a timer: by the time
      // somebody presses send, the shared tab is showing the last thing they
      // painted before coming to ask about it. `grab` returns null whenever
      // nothing is being shared, which is the ordinary case.
      const glance = screen.grab();
      // The id is minted here so the note under the question can be drawn
      // immediately, without waiting for the message to come back from the
      // database with the server's own id. The map is by id and not by index
      // because `reload()` rewrites the tail of the array.
      const id = crypto.randomUUID();
      if (glance) {
        pendingGlance.current = glance;
        setGlances((prev) => ({ ...prev, [id]: glance.takenAt }));
      }
      void append({ id, role: 'user', content: text });
    },
    [append, screen],
  );

  // ⌘K used to be registered here, which is why it only worked on /chat. The
  // palette is now mounted by the shell (nav/CommandMenuContext) so every
  // screen answers the shortcut — see the note there.

  const handleScopeChange = useCallback(
    (next: ScopeSpace[]) => {
      scopeRef.current = next;
      setScope(next);
      if (conversationId) {
        void setChatScopeAction(
          conversationId,
          next.map((s) => s.id),
        );
      }
    },
    [conversationId],
  );

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
          className="rounded-full p-1.5 text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink motion-reduce:transition-none md:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-soft text-primary ring-1 ring-inset ring-primary/15">
            <Brain className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold text-ink">
              {activeAgent?.name ?? 'Cortex'}
            </div>
            {/* The conversation id is what a person quotes when they need this
                exchange looked up later, so it is set as evidence, not prose. */}
            <div className="font-mono text-[10.5px] text-ink-faint">
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
        storedFollowups={initialFollowups}
        glances={initialGlances ? { ...initialGlances, ...glances } : glances}
      />

      {blocked && (
        <div
          role="status"
          className={clsx(
            'mx-4 mb-2 rounded-card border px-4 py-3 text-[12.5px] leading-relaxed',
            blocked.isLimit
              ? 'border-amber/25 bg-amber-soft text-amber'
              : 'border-rose/25 bg-rose-soft text-rose',
          )}
        >
          {blocked.message}
          {blocked.isLimit && (
            <>
              {' '}
              <Link href="/plan" className="font-semibold underline">
                Ver plan y consumo
              </Link>
            </>
          )}
        </div>
      )}

      <InputBar
        onSend={handleSend}
        disabled={isLoading}
        conversationId={conversationId}
        agents={agents}
        agentSlug={agentSlug}
        onAgentChange={handleAgentChange}
        draft={draft}
        onDraftConsumed={() => setDraft('')}
        scope={scope}
        onScopeChange={handleScopeChange}
        screen={screen}
      />
    </div>
  );
}
