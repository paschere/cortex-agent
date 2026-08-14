'use client';

import {
  type ExercisedMandate,
  type NoticePlanEntry,
  matchExercised,
} from '@/lib/mandates/delegation';
import type { ScreenFrame } from '@/lib/screen-marks';
import type { Message, ToolInvocation } from 'ai';
import { Brain, Check, Copy, RotateCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { ChatMarkdown } from './ChatMarkdown';
import { ConfirmationPrompt } from './ConfirmationPrompt';
import { DelegatedNotice } from './DelegatedNotice';
import { FollowUps } from './FollowUps';
import { ReasoningTrail } from './ReasoningTrail';
import { GlanceNote } from './ScreenView';
import { SelectionActions } from './SelectionActions';
import { TaskRows, type TurnMetrics } from './TaskRows';
import { DeclaredTable } from './results/DeclaredTable';
import { resolveView } from './results/registry';

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
  /**
   * The follow-ups saved with this answer, when the transcript came from the
   * database. Undefined on a live turn, which is the only case that asks the
   * server to make some.
   */
  storedFollowups?: string[];
  /**
   * When Cortex took one frame of the shared tab in order to answer this
   * question, ISO 8601. Only ever set on user messages, and only on the few
   * that were asked with a tab shared. See ScreenView.tsx.
   */
  glanceAt?: string;
  /**
   * The frame this answer was given, so a mark can be drawn on it — only on
   * ASSISTANT messages, and only while this tab has been open since the
   * question was asked. Undefined after a reload, which the card says out loud
   * rather than drawing boxes over nothing. See lib/screen-marks.ts.
   */
  screenFrame?: ScreenFrame | null;
  /**
   * Lo que Cortex hizo SIN PREGUNTAR en este mensaje, ya agrupado por mandato y
   * con la forma que le toca (entero la primera vez de cada mandato en la
   * conversación, una línea las siguientes). Lo calcula MessageList, que es
   * quien ve la conversación entera; un mensaje a solas no puede saber si su
   * mandato ya se anunció tres respuestas más arriba.
   */
  delegations?: NoticePlanEntry[];
  /** Las concesiones de esta conversación, leídas de la base. */
  exercisedMandates?: ExercisedMandate[];
  canRevokeMandates?: boolean;
  onMandateRevoked?: () => void;
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
  storedFollowups,
  glanceAt,
  screenFrame,
  delegations,
  exercisedMandates,
  canRevokeMandates,
  onMandateRevoked,
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
      <div className="flex flex-col items-end">
        <div className="max-w-[82%] whitespace-pre-wrap rounded-card rounded-br-sm bg-primary px-4 py-2.5 text-sm text-white shadow-card">
          {content}
        </div>
        {/* Under the question, not inside it: the person wrote the question and
            Cortex took the picture, and a line in the bubble would put the
            product's words in somebody else's mouth. */}
        {glanceAt && <GlanceNote at={glanceAt} />}
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
          Las llamadas se parten en dos. Una cuyo RESULTADO es sobre lo que la
          persona actúa —un borrador, una propuesta, una cola de aprobaciones—
          sube a tarjeta, porque es la salida del turno y no un paso hacia ella.
          Todo lo demás es un paso, y los pasos son renglones: ver `TaskRows`
          para por qué doce de ellos no pueden ser doce tarjetas.

          QUIÉN ES CUÁL LO DICE `results/registry.tsx`, Y NADIE MÁS AQUÍ. Este
          archivo ya no conoce el nombre de ninguna herramienta.
        */}
        {toolInvocations &&
          toolInvocations.length > 0 &&
          (() => {
            const cards: React.ReactNode[] = [];
            const steps: ToolInvocation[] = [];

            for (const inv of toolInvocations) {
              const result =
                inv.state === 'result' ? (inv as { result?: unknown }).result : undefined;

              // EL REGISTRO, Y NADA MÁS. Aquí vivían cuatro ramas `if`
              // escritas a mano —el borrador, la propuesta, las marcas sobre
              // la pantalla, el gráfico—, cada una con su predicado doble para
              // las dos grafías del mismo id. Convivieron con el registro
              // hasta que éste demostró que escalaba, que era la condición: no
              // hay derecho a tocar el camino que ya funciona para demostrar
              // que el nuevo también. Ahora son cuatro entradas del mapa, y
              // este bucle no sabe el nombre de ninguna herramienta.
              //
              // Una entrada RICH dibuja tarjeta; una TABLE también, con la
              // tabla que declara. Todo lo demás sigue siendo un paso — y un
              // paso ahora se LEE al desplegarlo, porque `TaskRows` pinta el
              // resultado con la capa estructural en vez del JSON en bruto.
              //
              // El resultado viaja a `resolveView` porque un puñado de vistas
              // no pueden dibujar sin algo concreto dentro (un gráfico sin
              // `chartId`), y ésas vuelven a ser un renglón en vez de una
              // tarjeta vacía. Sigue sin haber ninguna decisión de dominio
              // aquí: eso lo declara el registro.
              if (result !== undefined) {
                const resolved = resolveView(inv.toolName, result);
                if (resolved.as === 'rich') {
                  const View = resolved.View;
                  cards.push(
                    <View
                      key={inv.toolCallId}
                      result={result}
                      toolCallId={inv.toolCallId}
                      onSettled={onConfirmed}
                      screenFrame={screenFrame}
                    />,
                  );
                  continue;
                }
                if (resolved.as === 'table') {
                  cards.push(
                    <DeclaredTable key={inv.toolCallId} spec={resolved.spec} result={result} />,
                  );
                  continue;
                }
              }

              steps.push(inv);
            }

            return (
              <>
                <TaskRows invocations={steps} metrics={metrics ?? null} isStreaming={isStreaming} />
                {/*
                    Tres tarjetas es un turno bien contestado; siete es una
                    pared, que es exactamente lo que `TaskRows` existe para
                    evitar. Por encima de tres, se apilan y solo la primera
                    viene abierta.
                  */}
                {cards.length > 0 && <div className="space-y-1.5">{cards.slice(0, 3)}</div>}
                {cards.length > 3 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">
                      {cards.length - 3} resultado{cards.length - 3 === 1 ? '' : 's'} más
                    </summary>
                    <div className="mt-1.5 space-y-1.5">{cards.slice(3)}</div>
                  </details>
                )}
              </>
            );
          })()}

        {/*
          Lo que se hizo sin preguntar, dicho aquí y no en administración.

          Va DESPUÉS de los pasos y de las tarjetas, y antes de la petición de
          confirmación: primero lo que Cortex hizo, luego con qué permiso lo
          hizo, y al final lo que todavía necesita que alguien decida. Ese orden
          es el de la responsabilidad, y es el único que deja la pregunta
          pendiente pegada al composer, que es donde se contesta.
        */}
        {delegations?.map((entry) => (
          <DelegatedNotice
            key={`${message.id}:${entry.label}`}
            entry={entry}
            exercised={matchExercised(entry, exercisedMandates ?? [])}
            canRevoke={canRevokeMandates === true}
            onRevoked={onMandateRevoked}
          />
        ))}

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
            stored={storedFollowups}
            onPick={onCompose}
          />
        )}
      </div>
    </div>
  );
}
