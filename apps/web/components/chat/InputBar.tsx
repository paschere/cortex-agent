'use client';

import { useState, useRef } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArrowUp, ChevronDown } from 'lucide-react';
import { FileDropZone } from './FileDropZone';

interface AgentInfo {
  slug: string;
  name: string;
  description?: string;
}

interface InputBarProps {
  onSend: (text: string) => void;
  disabled: boolean;
  conversationId?: string;
  agents: AgentInfo[];
  agentSlug: string;
  onAgentChange: (slug: string) => void;
}

const CHAR_COUNT_THRESHOLD = 3500;

export function InputBar({
  onSend,
  disabled,
  conversationId,
  agents,
  agentSlug,
  onAgentChange,
}: InputBarProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeAgent = agents.find((a) => a.slug === agentSlug) ?? agents[0];
  const pillDisabled = !!conversationId;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    // Auto-resize textarea
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  return (
    <div className="border-t p-3 shrink-0">
      {conversationId && (
        <div className="mb-2">
          <FileDropZone conversationId={conversationId} />
        </div>
      )}
      <form
        className="flex flex-wrap sm:flex-nowrap gap-2 items-end"
        onSubmit={handleSubmit}
      >
        {/* Agent selector pill */}
        <div className="shrink-0 order-1">
          {pillDisabled ? (
            <button
              type="button"
              disabled
              title="Start a new chat to switch agents"
              className="inline-flex items-center gap-1 rounded-full border px-3 py-2 text-xs font-medium text-neutral-500 opacity-60 cursor-not-allowed"
            >
              {activeAgent?.name ?? 'Agent'}
            </button>
          ) : (
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border px-3 py-2 text-xs font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-300"
                >
                  {activeAgent?.name ?? 'Agent'}
                  <ChevronDown size={12} className="opacity-60" />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  side="top"
                  align="start"
                  sideOffset={6}
                  className="z-50 min-w-[220px] rounded-lg border bg-white dark:bg-neutral-900 p-1 shadow-md"
                >
                  {agents.map((a) => (
                    <DropdownMenu.Item
                      key={a.slug}
                      onSelect={() => onAgentChange(a.slug)}
                      className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm cursor-pointer outline-none data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800"
                    >
                      <span className="font-medium">{a.name}</span>
                      {a.description && (
                        <span className="text-xs text-neutral-500 line-clamp-1">
                          {a.description}
                        </span>
                      )}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>

        {/* Textarea */}
        <div className="relative flex-1 min-w-0 order-3 sm:order-2 w-full sm:w-auto">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything... (Enter to send, Shift+Enter for newline)"
            disabled={disabled}
            rows={1}
            className="w-full resize-none rounded-lg border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-300 disabled:opacity-50 overflow-hidden min-h-[38px]"
          />
          {text.length > CHAR_COUNT_THRESHOLD && (
            <span className="absolute bottom-1 right-2 text-[10px] text-neutral-400 tabular-nums pointer-events-none">
              {text.length}
            </span>
          )}
        </div>

        {/* Send button */}
        <button
          type="submit"
          disabled={disabled || !text.trim()}
          aria-label="Send message"
          className="shrink-0 order-2 sm:order-3 rounded-full p-1 bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900 disabled:opacity-50 transition"
        >
          <ArrowUp size={16} />
        </button>
      </form>
    </div>
  );
}
