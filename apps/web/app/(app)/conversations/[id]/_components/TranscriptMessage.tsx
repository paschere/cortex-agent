import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { ToolCallCard } from '@/components/chat/ToolCallCard';
import { Eyebrow, Panel } from '@/components/ui/panel';
import { toToolInvocations } from '@/lib/tool-invocations';
import { clsx } from 'clsx';
import { Sparkles, User } from 'lucide-react';

export interface TranscriptMessageRow {
  id: string;
  role: string;
  content: string;
  tool_calls: unknown;
  tool_results: unknown;
  created_at: string;
}

function speakerLabel(role: string, agentName: string): string {
  if (role === 'user') return 'Tú';
  if (role === 'assistant') return agentName;
  return role.charAt(0).toUpperCase() + role.slice(1);
}

/**
 * One archived turn. Deliberately renders through the very same pieces the
 * live chat uses — ChatMarkdown and ToolCallCard — so a transcript is the chat
 * you had, not a second interpretation of it.
 */
export function TranscriptMessage({
  message,
  agentName,
}: {
  message: TranscriptMessageRow;
  agentName: string;
}) {
  const isUser = message.role === 'user';
  const invocations = toToolInvocations(message.tool_calls, message.tool_results);
  const content = message.content?.trim() ?? '';

  return (
    <Panel className={clsx('p-4', isUser && 'border-primary/20 bg-primary-soft')}>
      <div className="mb-2 flex items-center gap-2">
        <span
          className={clsx(
            'grid h-7 w-7 shrink-0 place-items-center rounded-full text-white',
            isUser ? 'bg-ink' : 'bg-primary',
          )}
        >
          {isUser ? <User className="h-3.5 w-3.5" /> : <Sparkles className="h-4 w-4" />}
        </span>
        <span className="text-[12.5px] font-bold text-ink">
          {speakerLabel(message.role, agentName)}
        </span>
        <span className="tabular ml-auto shrink-0 text-[11px] text-ink-faint">
          {new Date(message.created_at).toLocaleString('es-CO', {
            day: '2-digit',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </span>
      </div>

      {content ? (
        isUser ? (
          <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{content}</p>
        ) : (
          <ChatMarkdown content={content} />
        )
      ) : !invocations ? (
        <p className="text-[13px] text-ink-faint">Mensaje vacío.</p>
      ) : null}

      {invocations && invocations.length > 0 && (
        <div className={clsx(content && 'mt-3')}>
          <div className="mb-1.5">
            <Eyebrow>Lo que hizo {agentName}</Eyebrow>
          </div>
          <div className="space-y-1.5">
            {invocations.map((inv) => (
              <ToolCallCard key={inv.toolCallId} invocation={inv} />
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
