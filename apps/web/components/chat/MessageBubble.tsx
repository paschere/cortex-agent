'use client';

import type { Message, ToolInvocation } from 'ai';
import { Check, Copy, RotateCw, Stamp } from 'lucide-react';
import { useState } from 'react';
import { ChatMarkdown } from './ChatMarkdown';
import { ConfirmationPrompt } from './ConfirmationPrompt';
import { ProposalCard, type ProposalResult } from './ProposalCard';
import { ReasoningTrail } from './ReasoningTrail';
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

/**
 * The turn's thinking, from wherever the SDK put it.
 *
 * AI SDK 4.3 streams reasoning into `parts` (one or more `reasoning` entries,
 * split wherever a tool call interrupted the thought) and also keeps the
 * deprecated flat `message.reasoning`. Parts are the reliable source while a
 * turn is streaming; the flat field is the fallback for anything that only
 * populates it.
 */
function reasoningOf(message: Message): string {
  const fromParts = (message.parts ?? [])
    .flatMap((p) => (p.type === 'reasoning' ? [p.reasoning] : []))
    .join('\n\n');
  return fromParts.trim() || (message.reasoning ?? '');
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
      className="rounded-card p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-muted"
      aria-label="Copiar mensaje"
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
    // What the person said is squared off and flat against the page: it is an
    // entry on the record, not a speech bubble floating over it.
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-card bg-primary px-3.5 py-2.5 text-sm text-white">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-card border border-primary/30 bg-primary-soft text-primary">
        <Stamp className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        {/* The margin note comes before the text it annotates, and disappears
            entirely on the many turns that carry no reasoning. */}
        <ReasoningTrail text={reasoningOf(message)} live={isStreaming && !content?.trim()} />

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
          // focus-within keeps these reachable by keyboard: hover-only controls
          // are invisible to anyone tabbing through the transcript.
          <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
            <CopyButton text={content} />
            {onRegenerate && (
              <button
                type="button"
                onClick={onRegenerate}
                className="rounded-card p-1.5 text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink-muted"
                aria-label="Volver a generar la respuesta"
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
