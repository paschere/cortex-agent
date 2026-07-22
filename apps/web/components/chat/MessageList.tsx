'use client';

import { useEffect, useRef } from 'react';
import type { Message } from 'ai';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';
import { EmptyState } from './EmptyState';

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  conversationId?: string;
  agent?: { slug: string; name: string; greeting: string };
  onConfirmed?: () => void;
  onRegenerate?: () => void;
  onSuggestion?: (text: string) => void;
}

export function MessageList({
  messages,
  isLoading,
  conversationId,
  agent,
  onConfirmed,
  onRegenerate,
  onSuggestion,
}: MessageListProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom || messages.length <= 1) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  const empty = messages.length === 0 && !isLoading;

  return (
    <div ref={ref} className="scroll-slim flex-1 overflow-y-auto">
      {empty ? (
        <div className="mx-auto flex h-full w-full max-w-3xl">
          <EmptyState agent={agent} onSuggestion={(t) => onSuggestion?.(t)} />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6">
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            return (
              <MessageBubble
                key={m.id}
                message={m}
                conversationId={conversationId}
                onConfirmed={onConfirmed}
                onRegenerate={isLast && m.role === 'assistant' ? onRegenerate : undefined}
                isStreaming={isLast && isLoading && m.role === 'assistant'}
              />
            );
          })}
          {isLoading && messages[messages.length - 1]?.role !== 'assistant' && <TypingIndicator />}
        </div>
      )}
    </div>
  );
}
