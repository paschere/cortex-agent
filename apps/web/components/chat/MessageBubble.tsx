'use client';

import type { Message, ToolInvocation } from 'ai';
import { Check, Copy, RotateCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { ChatMarkdown } from './ChatMarkdown';
import { ConfirmationPrompt } from './ConfirmationPrompt';
import { ProposalCard, type ProposalResult } from './ProposalCard';
import { ToolCallCard } from './ToolCallCard';

interface MessageBubbleProps {
  message: Message;
  conversationId?: string;
  onConfirmed?: () => void;
  onRegenerate?: () => void;
  isStreaming?: boolean;
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

function isProposalTool(toolName: string): boolean {
  return toolName === 'sales_draft_proposal' || toolName === 'sales.draft_proposal';
}

function isProposalResult(v: unknown): v is ProposalResult {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    !('__error' in o) &&
    !('__requires_confirmation' in o) &&
    typeof o.company === 'object' &&
    o.company !== null &&
    Array.isArray(o.roles)
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1400);
      }}
      className="rounded-[8px] p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-muted"
      aria-label="Copy message"
    >
      {done ? <Check className="h-3.5 w-3.5 text-emerald" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

export function MessageBubble({
  message,
  conversationId,
  onConfirmed,
  onRegenerate,
  isStreaming,
}: MessageBubbleProps) {
  const { role, content, toolInvocations } = message;
  if (role === 'data') return null;
  const isUser = role === 'user';

  const confirmationInvocation = toolInvocations?.find(
    (inv): inv is ToolInvocation & { state: 'result' } =>
      inv.state === 'result' && isConfirmationSentinel((inv as { result?: unknown }).result),
  );
  const confirmationData = confirmationInvocation
    ? (confirmationInvocation as unknown as { result: ConfirmationSentinel }).result
    : null;

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-white shadow-pop">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-strong text-white">
        <Sparkles className="h-4 w-4" />
      </span>

      <div className="min-w-0 flex-1">
        {content && <ChatMarkdown content={content} isStreaming={isStreaming} />}

        {toolInvocations && toolInvocations.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {toolInvocations.map((inv) => {
              const proposalResult =
                isProposalTool(inv.toolName) && inv.state === 'result'
                  ? (inv as { result?: unknown }).result
                  : undefined;
              if (proposalResult !== undefined && isProposalResult(proposalResult)) {
                return <ProposalCard key={inv.toolCallId} result={proposalResult} />;
              }
              return <ToolCallCard key={inv.toolCallId} invocation={inv} />;
            })}
          </div>
        )}

        {confirmationData && conversationId && (
          <div className="mt-2">
            <ConfirmationPrompt
              conversationId={conversationId}
              toolId={confirmationData.toolId}
              input={confirmationData.input}
              toolCallId={confirmationInvocation?.toolCallId}
              onConfirmed={onConfirmed}
            />
          </div>
        )}

        {!isStreaming && content && (
          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <CopyButton text={content} />
            {onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="rounded-[8px] p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-muted"
                aria-label="Regenerate response"
              >
                <RotateCw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
