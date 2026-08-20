'use client';

import { type AwaitingChoice, isAwaitingChoice } from '@/lib/ask-choice';
import type { BrainSource } from '@/lib/brain-sources-shape';
import {
  type ExercisedMandate,
  type NoticePlanEntry,
  matchExercised,
} from '@/lib/mandates/delegation';
import type { ScreenFrame } from '@/lib/screen-marks';
import type { Message, ToolInvocation } from 'ai';
import { clsx } from 'clsx';
import { useRef, useState } from 'react';
import { BrainSources, type CiteFocus } from './BrainSources';
import { ChatMarkdown } from './ChatMarkdown';
import { ChoicePrompt } from './ChoicePrompt';
import { ConfirmationPrompt } from './ConfirmationPrompt';
import { DelegatedNotice } from './DelegatedNotice';
import { FollowUps } from './FollowUps';
import { MessageActions } from './MessageActions';
import { Presence } from './Presence';
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
   * La pregunta que provocó esta respuesta, si la hay.
   *
   * Sólo se usa para titular el informe cuando alguien conserva la respuesta:
   * «¿Cuánto nos deben?» es el título que alguien va a reconocer en /reports
   * dentro de dos meses, y la primera línea de la respuesta no lo es. La busca
   * `MessageList`, que es quien ve el hilo entero.
   */
  question?: string;
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
  /**
   * Los documentos del cerebro que se pegaron encima de la pregunta que produjo
   * esta respuesta. Ausente —que es el caso normal— no dibuja nada: la regla de
   * procedencia del sistema de diseño dice que un valor sin procedencia no
   * lleva chip, porque un chip vacío devalúa todos los reales.
   */
  brainSources?: readonly BrainSource[];
  /**
   * Contestar una pregunta con opciones — escribe la elección como un mensaje
   * de la persona y arranca el turno siguiente. Es `handleSend` de `ChatRoot`,
   * el mismo que usa el compositor: una respuesta elegida con un botón y una
   * escrita a mano entran al hilo por el mismo sitio, que es lo que hace que la
   * conversación se lea igual dentro de dos semanas. Ver ChoicePrompt.
   */
  onAnswer?: (text: string) => void;
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

/**
 * EL CUERPO EN EL ORDEN EN QUE PASÓ.
 *
 * ===========================================================================
 * EL FALLO QUE ESTO ARREGLA
 * ===========================================================================
 * El cuerpo pintaba primero TODO el texto y después TODAS las herramientas,
 * así que una llamada hecha a mitad de la respuesta —«déjame revisar la
 * cartera» → consulta → «efectivamente, te deben…»— salía al final del
 * mensaje, después de un texto que ya hablaba de su resultado. El dueño lo
 * dijo exacto: «el llamado de herramientas siempre queda al final, no cuando
 * fue invocado en el timeline».
 *
 * La cronología SIEMPRE estuvo disponible: el SDK entrega `message.parts` con
 * texto, razonamiento y llamadas EN EL ORDEN REAL. Este archivo ya la usaba
 * para el razonamiento (`reasoningOf`) y la tiraba para todo lo demás.
 *
 * Devuelve la secuencia de segmentos —texto o tandas de llamadas consecutivas—
 * o `null` cuando el mensaje no trae partes con llamadas, que es el caso de
 * toda conversación REABIERTA: la base guarda el texto entero y las llamadas
 * por separado (`messages.content` + `tool_calls`), así que el entrelazado
 * original no existe y fingirlo sería inventar una cronología. Para ésas, el
 * que llama usa el orden menos falso: los pasos ANTES del texto, porque en el
 * caso típico las herramientas corren primero y la respuesta se escribe con
 * sus resultados delante.
 */
type BodySegment =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; invocations: ToolInvocation[] };

function segmentsOf(message: Message): BodySegment[] | null {
  const parts = (message.parts ?? []) as Array<
    | { type: 'text'; text: string }
    | { type: 'tool-invocation'; toolInvocation: ToolInvocation }
    | { type: string }
  >;
  if (!parts.some((part) => part.type === 'tool-invocation')) return null;

  const out: BodySegment[] = [];
  for (const part of parts) {
    if (part.type === 'text' && 'text' in part && part.text.trim()) {
      out.push({ kind: 'text', text: part.text });
    } else if (part.type === 'tool-invocation' && 'toolInvocation' in part) {
      const last = out[out.length - 1];
      if (last?.kind === 'tools') last.invocations.push(part.toolInvocation);
      else out.push({ kind: 'tools', invocations: [part.toolInvocation] });
    }
    // El razonamiento ya lo dibuja ReasoningTrail arriba; aquí se salta.
  }
  return out;
}

/**
 * La hora a la que se dijo, y la fecha entera detrás.
 *
 * A la vista sólo la hora, porque la fecha es una propiedad de la
 * CONVERSACIÓN —está en /conversations y en su cabecera— y repetirla veinte
 * veces en un hilo que ocurrió en una tarde es ruido. Quien necesita el día
 * exacto lo tiene en el `title` y en `dateTime`, que es lo que además lo hace
 * legible para una máquina.
 *
 * `null` cuando el mensaje no trae hora, que es el caso de un aviso de
 * vigilancia y de cualquier mensaje que no venga de la base: una hora
 * inventada en una transcripción que promete ser citable es peor que ninguna.
 */
function saidAt(message: Message): { time: string; full: string; iso: string } | null {
  const at = message.createdAt;
  if (!at) return null;
  const when = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(when.getTime())) return null;
  return {
    time: when.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }),
    full: when.toLocaleString('es-CO', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }),
    iso: when.toISOString(),
  };
}

/**
 * A partir de aquí una pregunta deja de ser un titular.
 *
 * Un titular de cuatro renglones no titula nada, y a 19px una pregunta larga
 * —una cita pegada, un párrafo de contexto— se convierte en la pared que este
 * rediseño existe para quitar. Por encima de este límite baja un paso de la
 * escala: sigue mandando sobre la respuesta, sin gritarla.
 */
const HEADLINE_MAX_CHARS = 180;

export function MessageBubble({
  message,
  conversationId,
  onConfirmed,
  onRegenerate,
  isStreaming,
  metrics,
  onCompose,
  question,
  storedFollowups,
  glanceAt,
  screenFrame,
  delegations,
  brainSources,
  onAnswer,
  exercisedMandates,
  canRevokeMandates,
  onMandateRevoked,
}: MessageBubbleProps) {
  const { role, content, toolInvocations } = message;
  // Scopes the selection menu to THIS answer: a selection that starts in one
  // message and ends in another offers nothing, because a quote spanning two
  // answers has no single source to attribute it to.
  const bodyRef = useRef<HTMLDivElement>(null);
  /**
   * La marca de cita pulsada en el texto de ESTA respuesta. Vive aquí porque
   * éste es el único sitio que ve a los dos lados: las pastillas de
   * `ChatMarkdown` que la disparan y la sección `BrainSources` que la
   * atiende (se abre, hace scroll y resalta la fuente con ese número). El
   * `nonce` es lo que hace que pulsar dos veces la misma cita vuelva a
   * resaltar. Ver BrainSources.
   */
  const [citeFocus, setCiteFocus] = useState<CiteFocus | null>(null);
  const onCiteClick =
    brainSources && brainSources.length > 0
      ? (cite: number) => setCiteFocus({ cite, nonce: Date.now() })
      : undefined;
  if (role === 'data') return null;
  const isUser = role === 'user';

  const confirmationInvocation = toolInvocations?.find(
    (inv): inv is ToolInvocation & { state: 'result' } =>
      inv.state === 'result' && isConfirmationSentinel((inv as { result?: unknown }).result),
  );
  const confirmationData = confirmationInvocation
    ? (confirmationInvocation as unknown as { result: ConfirmationSentinel }).result
    : null;

  /**
   * La pregunta con opciones, si este mensaje trae una.
   *
   * `find` y no `filter`: la ruta ya impide que haya dos en un turno
   * (`preguntadas` en /api/chat), y si alguna vez llegaran dos por un camino que
   * hoy no existe, dibujar la primera es mejor que apilar dos tarjetas.
   */
  const choiceInvocation = toolInvocations?.find(
    (inv): inv is ToolInvocation & { state: 'result' } =>
      inv.state === 'result' && isAwaitingChoice((inv as { result?: unknown }).result),
  );
  const choiceData = choiceInvocation
    ? (choiceInvocation as unknown as { result: AwaitingChoice }).result
    : null;

  if (isUser) {
    /**
     * =========================================================================
     * LA PREGUNTA ES EL TITULAR DE SU RESPUESTA
     * =========================================================================
     * Esto era una burbuja `bg-primary` al 82% de ancho con `shadow-card`: el
     * único relleno saturado y la única sombra de toda la transcripción. Lo más
     * corto y lo menos consultable de la pantalla se llevaba todo el peso, y la
     * respuesta —a lo que se vino— no tenía ninguno.
     *
     * Cortex no es una mensajería. Lo que se construye a lo largo de un día es
     * un registro de preguntas con sus respuestas y sus fuentes, y el producto
     * entero promete que eso se puede citar dos semanas después. En un registro
     * la pregunta no es un mensaje: es el TÍTULO de la entrada. Por eso es un
     * `h2` —un lector de pantalla salta de pregunta en pregunta, que es
     * exactamente como se recorre esto— y por eso está a 19px sobre una
     * respuesta a 13px.
     *
     * =========================================================================
     * EL SANGRADO ES LA ATRIBUCIÓN, Y ES LA PARTE QUE HABÍA QUE RESOLVER
     * =========================================================================
     * Quitar el relleno azul quita la convención de chat más reconocible que
     * hay, así que hacía falta otra cosa que dijera quién habla sin devolverle
     * el peso. Es la geometría:
     *
     *     ¿Cuánto nos deben?                              ← al margen, x = 0
     *     ●  Coltrans debe 42 millones…                   ← sangrado al carril
     *     │  [pasos] [fuentes]
     *
     *   · lo que dice una persona vive en el MARGEN IZQUIERDO;
     *   · todo lo que produce Cortex vive SANGRADO, con su carril al lado.
     *
     * Una sola regla, sin excepciones, y de las dos cosas que la sostienen
     * ninguna es un color: la sangría y la presencia. Un `##` de la respuesta
     * nunca puede salirse al margen, así que un encabezado de Cortex no puede
     * confundirse con una pregunta por muy grande que lo escriba el modelo.
     *
     * Y de paso la pregunta y su respuesta comparten el mismo ancho de línea,
     * que es lo que las lee como UNA unidad — ver la separación entre turnos en
     * `MessageList`.
     */
    const when = saidAt(message);
    const headline = content.length <= HEADLINE_MAX_CHARS;

    return (
      <header>
        {/*
          LA HORA ES UN ANTETÍTULO, Y ESTABA AL LADO.

          Es evidencia —regla 3 del sistema de diseño— y es media parte de poder
          citar esto dentro de dos semanas, así que se queda. Lo que cambió es
          dónde: estaba a la derecha en la misma línea, y ahí hacía dos cosas
          mal a la vez.

          En el teléfono se comía ochenta píxeles del ancho de CADA pregunta
          —medido a 390px: la pregunta larga rompía renglón cuatro palabras
          antes que su respuesta, para siempre—, y en el escritorio se quedaba
          sola contra el borde derecho de la columna, a cien píxeles de lo
          último que había escrito, que es el único sitio de la transcripción
          donde no llega nada más.

          Encima de la pregunta y al margen resuelve las dos: el titular
          recupera el ancho entero en cualquier pantalla y la hora se alinea con
          todo lo demás. Y es lo que hace un registro — la fecha antes de la
          entrada. Ver `saidAt` para por qué el día no se enseña.
        */}
        {when && (
          <time
            dateTime={when.iso}
            title={when.full}
            suppressHydrationWarning
            className="tabular mb-1 block text-micro text-ink-faint"
          >
            {when.time}
          </time>
        )}
        <h2
          className={clsx(
            // LA PREGUNTA NO PUEDE SER MÁS ANCHA QUE SU RESPUESTA, y lo era.
            //
            // El cuerpo de la respuesta mide 64ch y arranca sangrado al carril,
            // así que su renglón termina 37rem a la derecha de donde empieza la
            // pregunta. Sin tope, una pregunta larga se pasaba de largo por
            // cuarenta píxeles: un titular que sobresale de su propio texto se
            // lee como otra columna, no como su título.
            //
            // En `rem` y no en `ch` porque los dos tamaños del titular tienen
            // que terminar en la MISMA vertical, y un `ch` a 19px y uno a 15px
            // no miden lo mismo.
            'max-w-[37rem] whitespace-pre-wrap tracking-[-0.01em] text-ink',
            // Medido en pantalla: una pregunta pegada de cuatro renglones a
            // 19px semibold es la pared que esto vino a quitar, y encima
            // seguía en semibold al bajar a 15px. Larga baja de tamaño Y de
            // peso: la masa del bloque ya es todo el énfasis que necesita, y
            // lo que dice de quién es sigue siendo la sangría.
            headline ? 'text-lg font-semibold' : 'text-base font-medium',
          )}
        >
          {content}
        </h2>
        {/* Debajo de la pregunta, no dentro: la pregunta la escribió una
            persona y la foto la tomó Cortex, y meterlo en la misma línea
            pondría las palabras del producto en boca de otro. */}
        {glanceAt && <GlanceNote at={glanceAt} />}
      </header>
    );
  }

  return (
    /*
      =========================================================================
      EL CARRIL DE EVIDENCIA
      =========================================================================
      Una columna estrecha y fija a la izquierda de CADA respuesta. El cuerpo
      queda como prosa limpia y el carril es de donde cuelga todo lo demás.

      Antes esto era `items-start gap-3`: un avatar suelto al lado de un
      párrafo. La diferencia es `items-stretch` y la línea — la columna existe
      a lo alto de la respuesta entera, no sólo donde está el punto, así que
      prosa, pasos, avisos y procedencia quedan atados a una sola vertical. Es
      lo que permite que los turnos se separen SÓLO con espacio: dónde termina
      una respuesta lo dice el carril, no una raya que cruce la pantalla.

      LA LÍNEA ES UN FILETE, NO UN BORDE. `--border` sobre `--canvas` es un
      susurro (231/233/241 sobre 249/250/253) y eso es a propósito: la regla 2
      del sistema de diseño reserva las líneas para definir un canto y prohíbe
      que separen. Ésta no separa nada — mide la extensión de una respuesta.

      Y POR ESO `ReasoningTrail` PERDIÓ LA SUYA. Tenía su propio `border-l-2` a
      30px de ésta, que es la señal de que cada pieza de esta pantalla eligió su
      sitio por separado. Ahora hereda el carril, como todo lo demás.
    */
    <div className="group flex items-stretch gap-3 sm:gap-4">
      {/*
        LA MISMA PRESENCIA QUE ESTABA TRABAJANDO, YA CALMADA.

        Era un icono de cerebro idéntico en los treinta mensajes de un hilo.
        Ahora es `Presence`, el mismo objeto que giraba mientras se resolvía
        este turno: no desaparece un indicador y aparece un avatar, se queda
        quieto lo que estaba en marcha. Ver Presence.tsx.

        Tres estados y sólo tres, porque son los tres que esta posición puede
        conocer sin que nadie se los cuente:
          · escribiendo — hay texto saliendo AHORA en este mensaje;
          · esperándote — este mensaje contiene una confirmación sin decidir, o
            una pregunta sin contestar. Las dos paran el turno esperando a una
            persona, que es lo único que este estado dice; lo que las diferencia
            —si hay consecuencias o sólo hay una duda— lo dice la tarjeta con su
            color, y repetirlo aquí sería decirlo dos veces;
          · quieto — todo lo demás, que es la inmensa mayoría del historial.
      */}
      <div className="flex w-7 shrink-0 flex-col items-center">
        <Presence
          size="sm"
          state={
            isStreaming && !content?.trim()
              ? 'thinking'
              : isStreaming && content?.trim()
                ? 'writing'
                : (confirmationData && conversationId) ||
                    (choiceData && !!onRegenerate && !isStreaming)
                  ? 'waiting'
                  : 'resting'
          }
        />
        {/*
          EL CARRIL SE DESVANECE, Y NO ES UN ADORNO: ES QUE SE PASABA.

          Medido en pantalla: el carril mide el alto del cuerpo de la respuesta,
          y lo último del cuerpo es `MessageActions`, que en toda respuesta que
          no sea la última está ahí pero invisible hasta que le pasas el ratón
          por encima. O sea, 26px de fila vacía — y una raya sólida que la
          recorría y se cortaba en seco 36px por debajo de la última palabra.
          Parecía un trazo sin terminar en CADA respuesta del historial.

          Colapsar esa fila no sirve: la respuesta cambiaría de alto al pasar el
          ratón y el turno siguiente daría un salto. Así que la raya se apaga en
          sus últimos 36px, que es exactamente lo que sobra. Donde sobra, no se
          ve que sobre; donde no sobra —una respuesta con sus fuentes— termina
          en un degradado en vez de en un corte, que es como termina algo que
          mide una extensión en lugar de separar dos cosas.

          Y en un saludo de un renglón el carril entero cabe dentro del
          desvanecido: queda el punto y nada más, que es lo correcto.
        */}
        <span
          aria-hidden
          className="mt-2 w-px flex-1 rounded-full bg-border [-webkit-mask-image:linear-gradient(to_bottom,#000_calc(100%_-_2.25rem),transparent)] [mask-image:linear-gradient(to_bottom,#000_calc(100%_-_2.25rem),transparent)]"
        />
      </div>

      <div className="min-w-0 flex-1 pb-0.5">
        {/* The margin note comes before the text it annotates, and disappears
            entirely on the many turns that carry no reasoning. */}
        <ReasoningTrail text={reasoningOf(message)} live={isStreaming && !content?.trim()} />

        {(() => {
          /**
           * Una tanda de llamadas, partida como siempre: lo que sube a tarjeta
           * (la salida del turno) y lo que es un paso (un renglón). QUIÉN ES
           * CUÁL lo dice `results/registry.tsx`, y nadie más aquí — este
           * archivo sigue sin conocer el nombre de ninguna herramienta.
           */
          const split = (invs: ToolInvocation[]) => {
            const cards: React.ReactNode[] = [];
            const steps: ToolInvocation[] = [];
            for (const inv of invs) {
              // La pregunta no es un paso: su renglón diría «Preguntarte»
              // justo encima de la pregunta. Única duplicación literal posible.
              if (inv === choiceInvocation) continue;
              const result =
                inv.state === 'result' ? (inv as { result?: unknown }).result : undefined;
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
                      // El mismo canal de ChoicePrompt: lo que una tarjeta
                      // diga por la persona entra como mensaje de la persona.
                      onSay={onAnswer}
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
            return { cards, steps };
          };

          const segments = segmentsOf(message);
          const allCards: React.ReactNode[] = [];
          let body: React.ReactNode;

          if (segments) {
            /*
              EN EL ORDEN EN QUE PASÓ. Cada tanda de llamadas se dibuja donde
              se invocó, entre los trozos de texto que la rodearon. Las
              TARJETAS son la excepción deliberada: son la salida del turno
              —un borrador, una cola, una tabla— y el texto suele presentarlas
              («aquí está el borrador»), así que se izan al final aunque su
              llamada haya sido a mitad. Un paso es cronología; una tarjeta es
              el entregable.
            */
            const lastText = segments.reduce((acc, seg, i) => (seg.kind === 'text' ? i : acc), -1);
            body = segments.map((seg, i) => {
              if (seg.kind === 'text') {
                return (
                  <ChatMarkdown
                    key={`t${i}`}
                    content={seg.text}
                    isStreaming={isStreaming && i === lastText}
                    {...(brainSources ? { sources: brainSources } : {})}
                    {...(onCiteClick ? { onCiteClick } : {})}
                  />
                );
              }
              const { cards, steps } = split(seg.invocations);
              allCards.push(...cards);
              if (steps.length === 0) return null;
              return (
                <TaskRows
                  key={`s${i}`}
                  invocations={steps}
                  metrics={metrics ?? null}
                  isStreaming={isStreaming}
                  quiet={!!isStreaming && !content?.trim()}
                />
              );
            });
          } else {
            /*
              Sin partes no hay cronología que respetar — es toda conversación
              reabierta, donde la base guarda el texto y las llamadas por
              separado. El orden menos falso: los pasos ANTES del texto, porque
              en el caso típico las herramientas corren primero y la respuesta
              se escribe con sus resultados delante. Era al revés, y era el
              mismo fallo que esto arregla, congelado en el historial.
            */
            const { cards, steps } =
              toolInvocations && toolInvocations.length > 0
                ? split(toolInvocations)
                : { cards: [], steps: [] };
            allCards.push(...cards);
            body = (
              <>
                {steps.length > 0 && (
                  <TaskRows
                    invocations={steps}
                    metrics={metrics ?? null}
                    isStreaming={isStreaming}
                    quiet={!!isStreaming && !content?.trim()}
                  />
                )}
                {content && (
                  <ChatMarkdown
                    content={content}
                    isStreaming={isStreaming}
                    {...(brainSources ? { sources: brainSources } : {})}
                    {...(onCiteClick ? { onCiteClick } : {})}
                  />
                )}
              </>
            );
          }

          return (
            <>
              <div ref={bodyRef}>{body}</div>
              {/*
                Tres tarjetas es un turno bien contestado; siete es una pared,
                que es exactamente lo que `TaskRows` existe para evitar. Por
                encima de tres, se apilan y sólo la primera viene abierta.
              */}
              {allCards.length > 0 && <div className="space-y-1.5">{allCards.slice(0, 3)}</div>}
              {allCards.length > 3 && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer text-xs text-ink-muted hover:text-ink">
                    {allCards.length - 3} resultado{allCards.length - 3 === 1 ? '' : 's'} más
                  </summary>
                  <div className="mt-1.5 space-y-1.5">{allCards.slice(3)}</div>
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

        {/*
          La pregunta va donde va la confirmación y por el mismo motivo: lo
          último del mensaje es lo que está esperando a alguien, y así queda
          pegada al compositor, que es el otro sitio desde donde se contesta.

          `live` sale de `onRegenerate`, que MessageList sólo pasa a la última
          respuesta del hilo. O sea: la pregunta está viva mientras no haya nada
          debajo, que es literalmente lo que significa estar sin contestar —y
          por eso sobrevive a una recarga sin guardar ningún estado nuevo.
        */}
        {choiceData && (
          <ChoicePrompt
            question={choiceData.question}
            options={choiceData.options}
            live={!!onRegenerate && !isStreaming}
            {...(onAnswer ? { onAnswer } : {})}
          />
        )}

        {confirmationData && conversationId && (
          <div className="mt-2">
            <ConfirmationPrompt
              conversationId={conversationId}
              toolId={confirmationData.toolId}
              input={confirmationData.input}
              toolCallId={confirmationInvocation?.toolCallId}
              onConfirmed={onConfirmed}
              onSay={onAnswer}
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

        {/*
          LAS FUENTES, VISIBLES SIN HOVER Y SIN ESPERAR A LAS ACCIONES.

          Antes viajaban dentro de la fila de botones; ahora son una sección
          propia porque tienen que hablar con las pastillas del texto — pulsar
          una cita expande esto y resalta su fuente, y el único que ve a los
          dos es este componente. Va antes de las acciones: primero la prueba
          de dónde salió, después qué hacer con ello. Sin fuentes no dibuja
          nada — regla de procedencia del sistema de diseño.
        */}
        {!isStreaming && brainSources && brainSources.length > 0 && (
          <BrainSources sources={brainSources} focus={citeFocus} />
        )}

        {/*
          Copiar, rehacer y conservar. `onRegenerate` sólo llega en la última
          respuesta, así que es también la señal de cuál está viva y cuál se
          esconde hasta que se la busca — ver MessageActions.
        */}
        {!isStreaming && content && (
          <MessageActions
            text={content}
            messageId={message.id}
            pinned={!!onRegenerate}
            {...(question ? { question } : {})}
            {...(conversationId ? { conversationId } : {})}
            {...(onRegenerate ? { onRegenerate } : {})}
          />
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
