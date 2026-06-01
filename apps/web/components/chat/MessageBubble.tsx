'use client';

import type { Message, ToolInvocation } from 'ai';
import { clsx } from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { ToolCallCard } from './ToolCallCard';
import { ConfirmationPrompt } from './ConfirmationPrompt';

interface MessageBubbleProps {
  message: Message;
  conversationId?: string;
  onConfirmed?: () => void;
}

type ConfirmationSentinel = {
  __requires_confirmation: true;
  toolId: string;
  input: unknown;
};

function isConfirmationSentinel(v: unknown): v is ConfirmationSentinel {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.__requires_confirmation === true && typeof o.toolId === 'string';
}

export function MessageBubble({ message, conversationId, onConfirmed }: MessageBubbleProps) {
  const { role, content, toolInvocations } = message;

  // Skip data role messages
  if (role === 'data') return null;

  const isUser = role === 'user';

  // Find any confirmation-required tool invocations
  const confirmationInvocation = toolInvocations?.find(
    (inv): inv is ToolInvocation & { state: 'result' } =>
      inv.state === 'result' && isConfirmationSentinel((inv as { result?: unknown }).result),
  );

  const confirmationData = confirmationInvocation
    ? (confirmationInvocation as unknown as { result: ConfirmationSentinel }).result
    : null;

  return (
    <div className={clsx('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={clsx(
          'rounded-2xl px-4 py-2 max-w-[80%] text-sm',
          isUser
            ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
            : 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100',
        )}
      >
        {content && isUser && (
          <div className="whitespace-pre-wrap">{content}</div>
        )}

        {content && !isUser && (
          <div className="prose prose-sm dark:prose-invert max-w-none overflow-x-auto prose-headings:mt-2 prose-p:mt-1 prose-p:mb-0 prose-li:my-0 prose-ul:my-1 prose-ol:my-1">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
            >
              {content}
            </ReactMarkdown>
          </div>
        )}

        {/* Tool call cards */}
        {toolInvocations && toolInvocations.length > 0 && (
          <div className="mt-2 space-y-1">
            {toolInvocations.map((inv) => (
              <ToolCallCard
                key={inv.toolCallId}
                name={inv.toolName}
                args={inv.args}
                result={'result' in inv ? (inv as { result: unknown }).result : undefined}
                state={inv.state}
              />
            ))}
          </div>
        )}

        {/* Confirmation prompt for tool requiring confirmation */}
        {confirmationData && conversationId && (
          <ConfirmationPrompt
            conversationId={conversationId}
            toolId={confirmationData.toolId}
            input={confirmationData.input}
            onConfirmed={onConfirmed}
          />
        )}
      </div>
    </div>
  );
}
