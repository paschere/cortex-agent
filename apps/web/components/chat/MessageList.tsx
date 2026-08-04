'use client';

import { useEffect, useRef } from 'react';
import type { Message } from 'ai';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';
import { EmptyState } from './EmptyState';
import { toolDisplayName } from '@/lib/tool-labels';

/**
 * What the assistant is busy with, in the user's words.
 *
 * A turn that calls tools produces an assistant message with tool invocations
 * and no text for as long as those calls take. Reporting the newest unfinished
 * call — rather than the first — keeps the line moving through a chain of them.
 */
function busyLabel(message: Message | undefined): string | undefined {
  const pending = message?.toolInvocations?.filter((inv) => inv.state !== 'result');
  const current = pending?.[pending.length - 1];
  return current ? `${toolDisplayName(current.toolName)}…` : undefined;
}

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
          {/*
            Keep the indicator up while the assistant message exists but has no
            text yet — during tool calls it is empty, and hiding the indicator
            the moment it appears is what left the screen looking blank.
          */}
          {(() => {
            const last = messages[messages.length - 1];
            const assistantIsSilent =
              last?.role === 'assistant' && !last.content?.trim();
            if (!isLoading || (last?.role === 'assistant' && !assistantIsSilent)) return null;
            return <TypingIndicator label={busyLabel(last)} />;
          })()}
        </div>
      )}
    </div>
  );
}
