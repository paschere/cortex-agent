'use client';

import { toolDisplayName } from '@/lib/tool-labels';
import type { Message } from 'ai';
import { useEffect, useRef, useState } from 'react';
import { EmptyState } from './EmptyState';
import { MessageBubble } from './MessageBubble';
import type { TurnMetrics } from './TaskRows';
import { TypingIndicator } from './TypingIndicator';

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

/** Whether the turn is already narrating itself through its reasoning trail. */
function hasReasoning(message: Message | undefined): boolean {
  if (!message) return false;
  if (message.reasoning?.trim()) return true;
  return (message.parts ?? []).some((p) => p.type === 'reasoning' && p.reasoning.trim().length > 0);
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
  const [metrics, setMetrics] = useState<TurnMetrics | null>(null);

  /**
   * The real timings, fetched once the turn is over.
   *
   * They are written from `onFinish` on the server, so they cannot be read
   * before the answer is complete — which is fine, because they are not
   * progress, they are the record. The task rows show an elapsed counter while
   * a call is in flight and swap in the measurement when it arrives.
   *
   * Only for the newest turn. Older ones keep whatever they were rendered with;
   * fetching a timing row per message would be one query per message on every
   * scroll, for a number almost nobody looks at twice.
   */
  useEffect(() => {
    if (isLoading || !conversationId) return;
    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant') return;

    let alive = true;
    const timer = setTimeout(() => {
      fetch(`/api/chat/turn-metrics?conversationId=${encodeURIComponent(conversationId)}`)
        .then((r) => (r.ok ? r.json() : { metrics: null }))
        .then((data: { metrics: TurnMetrics | null }) => {
          if (alive && data.metrics) setMetrics(data.metrics);
        })
        .catch(() => {
          // No numbers is a fine outcome: the rows simply show none.
        });
    }, 600);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [isLoading, conversationId, messages]);

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
                metrics={isLast ? metrics : null}
                onCompose={onSuggestion}
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
            const assistantIsSilent = last?.role === 'assistant' && !last.content?.trim();
            if (!isLoading || (last?.role === 'assistant' && !assistantIsSilent)) return null;
            const label = busyLabel(last);
            // Once the reasoning trail is running it is the better progress
            // signal, so the dots stand down — unless a tool is in flight, in
            // which case naming it says something the reasoning does not.
            if (!label && hasReasoning(last)) return null;
            return <TypingIndicator label={label} />;
          })()}
        </div>
      )}
    </div>
  );
}
