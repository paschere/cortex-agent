'use client';

import { useEffect, useRef } from 'react';
import type { Message } from 'ai';
import { MessageBubble } from './MessageBubble';

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  conversationId?: string;
  onConfirmed?: () => void;
}

export function MessageList({ messages, isLoading, conversationId, onConfirmed }: MessageListProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, isLoading]);

  return (
    <div ref={ref} className="flex-1 overflow-y-auto p-4 space-y-3">
      {messages.length === 0 && !isLoading && (
        <div className="flex items-center justify-center h-full text-neutral-400 text-sm">
          Start a conversation...
        </div>
      )}
      {messages.map((m) => (
        <MessageBubble key={m.id} message={m} conversationId={conversationId} onConfirmed={onConfirmed} />
      ))}
      {isLoading && messages[messages.length - 1]?.role !== 'assistant' && (
        <div className="flex items-start gap-2">
          <div className="rounded-2xl px-4 py-2 bg-neutral-100 dark:bg-neutral-800 text-sm text-neutral-500 animate-pulse">
            Thinking...
          </div>
        </div>
      )}
    </div>
  );
}
