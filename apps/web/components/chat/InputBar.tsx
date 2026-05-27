'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { FileDropZone } from './FileDropZone';

interface InputBarProps {
  onSend: (text: string) => void;
  disabled: boolean;
  conversationId?: string;
}

export function InputBar({ onSend, disabled, conversationId }: InputBarProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      <form className="flex gap-2 items-end" onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything... (Enter to send, Shift+Enter for newline)"
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none rounded-lg border bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-300 disabled:opacity-50 overflow-hidden min-h-[38px]"
        />
        <Button type="submit" disabled={disabled || !text.trim()} className="shrink-0">
          Send
        </Button>
      </form>
    </div>
  );
}
