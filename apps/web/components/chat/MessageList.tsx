'use client';

import { useEffect, useRef, useState } from 'react';
import type { Message } from 'ai';
import { ChevronDown } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  conversationId?: string;
  onConfirmed?: () => void;
}

export function MessageList({ messages, isLoading, conversationId, onConfirmed }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const isNearBottom = scrollHeight - scrollTop - clientHeight < 120;
    if (isNearBottom) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading]);

  function handleScroll() {
    const container = containerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
    setShowScrollButton(distanceFromBottom > 120);
  }

  function scrollToBottom() {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  const lastMessage = messages[messages.length - 1];
  const isStreamingAssistant = isLoading && lastMessage?.role === 'assistant';
  const showTypingIndicator = isLoading && lastMessage?.role !== 'assistant';

  return (
    <div className="relative flex-1 overflow-hidden">
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto p-4 space-y-3"
      >
        {messages.length === 0 && !isLoading && (
          <div className="flex items-center justify-center h-full text-neutral-400 text-sm">
            Start a conversation...
          </div>
        )}
        {messages.map((m, index) => {
          const isLastAssistant = isStreamingAssistant && index === messages.length - 1 && m.role === 'assistant';
          return (
            <div key={m.id}>
              <MessageBubble
                message={m}
                conversationId={conversationId}
                onConfirmed={onConfirmed}
              />
              {isLastAssistant && (
                <div className="flex justify-start px-4 -mt-1">
                  <span
                    className="inline-block w-0.5 h-4 bg-neutral-500 dark:bg-neutral-400 ml-1 animate-pulse"
                    aria-hidden="true"
                  />
                </div>
              )}
            </div>
          );
        })}
        {showTypingIndicator && <TypingIndicator />}
        <div ref={endRef} />
      </div>

      {showScrollButton && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 right-4 flex items-center justify-center w-8 h-8 rounded-full bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 shadow-md hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
          aria-label="Scroll to bottom"
        >
          <ChevronDown className="w-4 h-4 text-neutral-600 dark:text-neutral-300" />
        </button>
      )}
    </div>
  );
}
