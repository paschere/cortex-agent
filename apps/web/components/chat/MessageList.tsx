'use client';

import { type ExercisedMandate, planNotices } from '@/lib/mandates/delegation';
import type { ScreenFrame } from '@/lib/screen-marks';
import { toolDisplayName } from '@/lib/tool-labels';
import type { Message } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

/**
 * The frame the question at or before `index` was asked with, if this tab still
 * holds it.
 *
 * Only answers are ever handed one, and only ever the frame of the question
 * they were the answer to — so an answer that pointed at something draws on the
 * picture the model was actually looking at, and never on a newer one taken for
 * a different question. Returns undefined for everything else, which is the
 * ordinary case and the case after a reload.
 */
function nearestQuestionFrame(
  messages: Message[],
  index: number,
  frames: Record<string, ScreenFrame>,
): ScreenFrame | undefined {
  if (messages[index]?.role !== 'assistant') return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return frames[m.id];
  }
  return undefined;
}

interface MessageListProps {
  messages: Message[];
  isLoading: boolean;
  conversationId?: string;
  agent?: { slug: string; name: string; greeting: string };
  onConfirmed?: () => void;
  onRegenerate?: () => void;
  onSuggestion?: (text: string) => void;
  /**
   * Follow-ups already saved, by message id. Only the newest answer can ever
   * show any, so this holds at most one entry — it is a map rather than a
   * single value so nothing here has to work out which message that is.
   */
  storedFollowups?: Record<string, string[]>;
  /**
   * Which questions were asked with a look at the person's shared tab, by
   * message id, and when the picture was taken. The picture itself was never
   * stored anywhere — see migration 0092 — so this timestamp is the whole of
   * what a screen question leaves behind, and it is drawn under the question
   * because a record somebody cannot see is not a record.
   */
  glances?: Record<string, string>;
  /**
   * The frames themselves, by the id of the QUESTION they were taken for, and
   * only for this tab's own session — nothing here ever came from the database.
   * An answer that pointed at something needs the picture its question carried,
   * which is why the lookup below walks backwards from the answer rather than
   * reading its own id. See ChatRoot and lib/screen-marks.ts.
   */
  frames?: Record<string, ScreenFrame>;
}

export function MessageList({
  messages,
  isLoading,
  conversationId,
  agent,
  onConfirmed,
  onRegenerate,
  onSuggestion,
  storedFollowups,
  glances,
  frames,
}: MessageListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<TurnMetrics | null>(null);
  const [exercised, setExercised] = useState<ExercisedMandate[]>([]);
  const [canRevoke, setCanRevoke] = useState(false);

  /**
   * Lo que se hizo SIN PREGUNTAR, por mensaje.
   *
   * Se calcula sobre la conversación entera y no mensaje a mensaje porque la
   * regla que evita el ruido es de conversación: la primera vez que un mandato
   * actúa se enseña entero y las siguientes en una línea, y eso solo se puede
   * decidir viendo lo que ya se anunció más arriba. Ver la cabecera de
   * `lib/mandates/delegation.ts`.
   *
   * La señal sale del `_security` que viene pegado al resultado de cada llamada,
   * así que existe también en una conversación reabierta: los resultados se
   * guardan enteros en `messages.tool_results`.
   */
  const noticePlan = useMemo(
    () => planNotices(messages.map((m) => ({ id: m.id, invocations: m.toolInvocations ?? [] }))),
    [messages],
  );

  // Una firma estable de lo delegado. El array `messages` cambia de identidad en
  // cada token que llega, y depender de él haría una consulta por token.
  const delegationKey = useMemo(
    () =>
      Object.values(noticePlan)
        .flat()
        .map((d) => d.label)
        .sort()
        .join('|'),
    [noticePlan],
  );

  /**
   * Quién autorizó cada uno de esos mandatos, y cuándo.
   *
   * Se vuelve a pedir después de revocar y no se guarda nada entre medias, por
   * el mismo motivo por el que `loadMandates` no memoiza: una revocación muerde
   * en la llamada siguiente, y un aviso que siguiera diciendo «en vigor» un
   * minuto después de apagarlo desharía esa promesa justo donde se está usando.
   */
  const loadExercised = useCallback(async () => {
    if (!conversationId) return;
    try {
      const res = await fetch(
        `/api/mandates/exercised?conversationId=${encodeURIComponent(conversationId)}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        canRevoke?: boolean;
        delegations?: ExercisedMandate[];
      };
      setExercised(data.delegations ?? []);
      setCanRevoke(data.canRevoke === true);
    } catch {
      // Sin la fila, el aviso sale sin fecha y sin botón. Nunca con una fecha
      // inventada: ver `authorizationPhrase`.
    }
  }, [conversationId]);

  // Solo cuando hay algo delegado que explicar: una conversación normal, que es
  // la inmensa mayoría, no paga ninguna consulta.
  useEffect(() => {
    if (!delegationKey) return;
    void loadExercised();
  }, [delegationKey, loadExercised]);

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
            // The picture belongs to the question; the marks belong to the
            // answer. Walking back to the nearest question is what joins them,
            // and it is done here rather than by keying frames on the answer's
            // id because that id does not exist yet when the frame is taken —
            // it comes back from the server after the turn.
            const askedWith = frames ? nearestQuestionFrame(messages, i, frames) : undefined;
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
                storedFollowups={storedFollowups?.[m.id]}
                glanceAt={glances?.[m.id]}
                screenFrame={askedWith}
                delegations={noticePlan[m.id]}
                exercisedMandates={exercised}
                canRevokeMandates={canRevoke}
                onMandateRevoked={() => void loadExercised()}
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
