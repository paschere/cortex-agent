'use client';

import { ProposedActionCard } from '@/components/actions/ProposedActionCard';
import type { ActionView } from '@/lib/actions-shape';
import type { Message, ToolInvocation } from 'ai';
import { Brain, Check, Copy, RotateCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { ChartCard } from './ChartCard';
import { ChatMarkdown } from './ChatMarkdown';
import { ConfirmationPrompt } from './ConfirmationPrompt';
import { FollowUps } from './FollowUps';
import { ProposalCard, type ProposalResult } from './ProposalCard';
import { ReasoningTrail } from './ReasoningTrail';
import { SelectionActions } from './SelectionActions';
import { TaskRows, type TurnMetrics } from './TaskRows';

interface MessageBubbleProps {
  message: Message;
  conversationId?: string;
  onConfirmed?: () => void;
  onRegenerate?: () => void;
  isStreaming?: boolean;
  /** Real per-call durations for the newest turn. Null until they land. */
  metrics?: TurnMetrics | null;
  /** Puts text in the composer — used by follow-ups and by the selection menu. */
  onCompose?: (text: string) => void;
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
 * The turn that ends in something you can say yes to.
 *
 * `actions.propose` returns a drafted email; rendering it as a plain tool card
 * would show the JSON of a message and leave the person to go find where to
 * approve it, which is the exact gap this whole feature exists to close. So the
 * card comes up in the thread, with the text, the recipient and the buttons.
 */
function isProposedActionTool(toolName: string): boolean {
  return toolName === 'actions_propose' || toolName === 'actions.propose';
}

function isProposedActionResult(v: unknown): v is { action: ActionView } {
  if (!v || typeof v !== 'object' || '__error' in v) return false;
  const action = (v as { action?: unknown }).action;
  if (!action || typeof action !== 'object') return false;
  const a = action as Record<string, unknown>;
  return typeof a.id === 'string' && typeof a.contentHash === 'string';
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

function isChartTool(toolName: string): boolean {
  return toolName === 'reports_chart' || toolName === 'reports.chart';
}

/**
 * The tool returns an id, not a picture — the SVG would otherwise be replayed
 * into the model's context on every later turn of the conversation. `ChartCard`
 * fetches the drawing by that id.
 */
function chartIdOf(v: unknown): string | null {
  if (!v || typeof v !== 'object' || '__error' in v) return null;
  const id = (v as { chartId?: unknown }).chartId;
  return typeof id === 'string' ? id : null;
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
      className="rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
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
  metrics,
  onCompose,
}: MessageBubbleProps) {
  const { role, content, toolInvocations } = message;
  // Scopes the selection menu to THIS answer: a selection that starts in one
  // message and ends in another offers nothing, because a quote spanning two
  // answers has no single source to attribute it to.
  const bodyRef = useRef<HTMLDivElement>(null);
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
    // What the person said gets the one saturated fill in the transcript, and
    // a corner softened on the side it was sent from.
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-card rounded-br-sm bg-primary px-4 py-2.5 text-sm text-white shadow-card">
          {content}
        </div>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary-soft text-primary ring-1 ring-inset ring-primary/15">
        <Brain className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        {/* The margin note comes before the text it annotates, and disappears
            entirely on the many turns that carry no reasoning. */}
        <ReasoningTrail text={reasoningOf(message)} live={isStreaming && !content?.trim()} />

        <div ref={bodyRef}>
          {content && <ChatMarkdown content={content} isStreaming={isStreaming} />}
        </div>

        {/*
          Tool calls now split three ways. A call whose RESULT is something the
          person acts on — a drafted email, a proposal, a chart — keeps its own
          card, because those are the turn's output rather than a step toward
          it. Everything else is a step, and steps are rows: see TaskRows for
          why twelve of them cannot be twelve cards.
        */}
        {toolInvocations && toolInvocations.length > 0 && (
          <>
            {(() => {
              const cards: React.ReactNode[] = [];
              const steps: ToolInvocation[] = [];

              for (const inv of toolInvocations) {
                const result =
                  inv.state === 'result' ? (inv as { result?: unknown }).result : undefined;

                if (
                  isProposedActionTool(inv.toolName) &&
                  result !== undefined &&
                  isProposedActionResult(result)
                ) {
                  cards.push(
                    <ProposedActionCard
                      key={inv.toolCallId}
                      action={result.action}
                      dense
                      onSettled={onConfirmed}
                    />,
                  );
                  continue;
                }
                if (isProposalTool(inv.toolName) && result !== undefined && isProposalResult(result)) {
                  cards.push(<ProposalCard key={inv.toolCallId} result={result} />);
                  continue;
                }
                if (isChartTool(inv.toolName)) {
                  const chartId = chartIdOf(result);
                  if (chartId) {
                    cards.push(
                      <ChartCard
                        key={inv.toolCallId}
                        chartId={chartId}
                        heading={
                          (result as { heading?: string } | undefined)?.heading ?? 'Gráfico'
                        }
                      />,
                    );
                    continue;
                  }
                }
                steps.push(inv);
              }

              return (
                <>
                  <TaskRows
                    invocations={steps}
                    metrics={metrics ?? null}
                    isStreaming={isStreaming}
                  />
                  {cards.length > 0 && <div className="space-y-1.5">{cards}</div>}
                </>
              );
            })()}
          </>
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

        {!isStreaming && content && onCompose && (
          <SelectionActions
            containerRef={bodyRef}
            provenance={{
              conversationId,
              saidAt: new Date(message.createdAt ?? Date.now()).toLocaleDateString('es-CO', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              }),
            }}
            onAsk={(quote) => onCompose(`Sobre esto que dijiste:\n\n> ${quote}\n\n`)}
          />
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
                className="rounded-full p-1.5 text-ink-faint transition-colors duration-150 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
                aria-label="Volver a generar la respuesta"
              >
                <RotateCw className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Only under the newest answer: a transcript with a strip of
            suggestions after every message is a transcript of suggestions. */}
        {onRegenerate && onCompose && content && (
          <FollowUps
            conversationId={conversationId}
            messageId={message.id}
            ready={!isStreaming}
            onPick={onCompose}
          />
        )}
      </div>
    </div>
  );
}
