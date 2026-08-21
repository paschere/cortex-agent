'use client';

import type { BrainSource } from '@/lib/brain-sources-shape';
import { type ExercisedMandate, planNotices } from '@/lib/mandates/delegation';
import type { ScreenFrame } from '@/lib/screen-marks';
import { toolDisplayName } from '@/lib/tool-labels';
import type { WaitingNoticeData } from '@/lib/waiting-shape';
import type { Message } from 'ai';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EmptyState } from './EmptyState';
import { LiveStatus } from './LiveStatus';
import { MessageBubble } from './MessageBubble';
import type { TurnMetrics } from './TaskRows';

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

/**
 * La pregunta que provocó la respuesta de `index`, si la hay.
 *
 * El mismo paseo hacia atrás que `nearestQuestionFrame`, y por la misma razón:
 * una respuesta no sabe de qué era respuesta. Sirve para titular el informe
 * cuando alguien conserva la respuesta — ver `MessageActions`.
 */
function nearestQuestion(messages: Message[], index: number): string | undefined {
  if (messages[index]?.role !== 'assistant') return undefined;
  for (let i = index - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') return typeof m.content === 'string' ? m.content : undefined;
  }
  return undefined;
}

/**
 * ===========================================================================
 * EL TURNO: LA UNIDAD QUE FALTABA
 * ===========================================================================
 * Aquí había un `space-y-6` entre todo. Una pregunta quedaba a la misma
 * distancia de SU respuesta que de un turno de hace una hora, así que la
 * maquetación no decía lo primero que tiene que decir de una conversación: qué
 * va con qué. Treinta mensajes eran treinta cosas sueltas.
 *
 * Un turno es una pregunta y todo lo que Cortex contestó debajo, y se dibuja
 * como un `<article>` con su `h2` — que es lo que además deja saltar de
 * pregunta en pregunta a quien navega escuchando.
 *
 * LA MEDIDA ES LA DECISIÓN, y va con intención: 14px por dentro contra 44px
 * entre turnos, tres veces más. Nada de rayas: una regla horizontal cruzando la
 * pantalla cada tres párrafos es el libro de contabilidad que este producto
 * sustituye, y el carril de cada respuesta ya dice dónde termina.
 *
 * Un turno sin pregunta es legal y es de dos clases: el saludo con el que
 * arranca un hilo y el aviso que entra solo cuando Cortex está mirando una
 * pestaña compartida. Los dos abren turno propio en vez de colarse al final del
 * anterior — un aviso pegado a la respuesta de otra pregunta se lee como parte
 * de ella.
 */
interface Turn {
  key: string;
  /** Índices en `messages`, que es lo que necesitan los ayudantes de arriba. */
  at: number[];
}

export function turnsOf(messages: Pick<Message, 'id' | 'role'>[]): Turn[] {
  const turns: Turn[] = [];
  let answered = false;
  for (const [i, m] of messages.entries()) {
    const last = turns[turns.length - 1];
    // Una respuesta seguida de otra respuesta no es la continuación de nada:
    // `useChat` produce exactamente una por pregunta, así que la segunda sólo
    // puede ser un saludo o un aviso de vigilancia. Abre turno.
    const opens = m.role === 'user' || !last || (m.role === 'assistant' && answered);
    if (opens) {
      turns.push({ key: m.id, at: [i] });
      answered = false;
    } else {
      last.at.push(i);
    }
    if (m.role === 'assistant') answered = true;
  }
  return turns;
}

/**
 * ===========================================================================
 * QUIÉN MANDA EN EL SCROLL, Y POR QUÉ HAY QUE DECIDIRLO DOS VECES
 * ===========================================================================
 * El contenedor que scrollea es el `<div>` de abajo, así que la decisión vive
 * aquí y no en `ChatRoot`. Y son DOS decisiones distintas que estaban escritas
 * como una sola, que es de donde salía el defecto:
 *
 *   ATERRIZAR. Abrir un hilo guardado tiene que dejar la vista en el final. Lo
 *   último dicho es lo que se vino a leer; el principio de una conversación de
 *   hace tres semanas no es el sitio donde empieza nadie.
 *
 *   SEGUIR. Mientras llegan tokens, la vista acompaña — PERO SÓLO si la persona
 *   estaba abajo. Si subió a releer, un token nuevo no puede arrastrarla.
 *
 * La regla que había cubría la segunda y no la primera: «pega al fondo si ya
 * estás cerca del fondo». Al montar un hilo largo `scrollTop` es 0, así que la
 * distancia al fondo es la conversación entera y la condición daba falso — la
 * vista se quedaba arriba y había que bajar a mano cada vez. La otra mitad de
 * la condición, `messages.length <= 1`, sólo salvaba al hilo recién abierto.
 *
 * `landed` es lo que separa las dos: falso hasta que este hilo se ancló una
 * vez. Un aterrizaje no compite con nadie —nadie ha tenido tiempo de scrollear
 * todavía— así que no mira la distancia y no se anima.
 */

/** Cuánto puede haberse alejado alguien del fondo y seguir contando como «ahí». */
const STUCK_TO_BOTTOM_PX = 160;

export type ScrollIntent = 'land' | 'follow' | 'stay';

/**
 * Qué hacer con la vista, dado dónde está y si este hilo ya aterrizó.
 *
 * Pura y exportada porque es la única parte de esto que se puede equivocar en
 * silencio: las tres respuestas se ven idénticas en una captura de pantalla, y
 * la que falla —`stay` cuando tocaba `land`— no rompe nada, sólo deja a alguien
 * leyendo el principio de su conversación. Ver `MessageList.test.ts`.
 */
export function scrollIntent(
  view: { scrollHeight: number; scrollTop: number; clientHeight: number },
  opts: { landed: boolean },
): ScrollIntent {
  if (!opts.landed) return 'land';
  const below = view.scrollHeight - view.scrollTop - view.clientHeight;
  return below < STUCK_TO_BOTTOM_PX ? 'follow' : 'stay';
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
   * Contestar una pregunta con opciones: manda la elección como un mensaje de
   * la persona. Es el mismo `handleSend` del compositor — ver ChoicePrompt.
   */
  onAnswer?: (text: string) => void;
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
  /**
   * Qué documentos del cerebro se leyeron para cada respuesta ya guardada.
   *
   * Los del turno que acaba de terminar NO vienen por aquí: los escribe
   * `onFinish` en el servidor y llegan con las cifras del turno, por el mismo
   * viaje. Ver el efecto de `/api/chat/turn-metrics` más abajo.
   */
  initialBrainSources?: Record<string, BrainSource[]>;
  /**
   * Lo que espera a esta persona. En un chat vacío se dice como la frase del
   * día; con un hilo abierto no se dibuja aquí — el rail ya lleva el total.
   */
  waiting?: WaitingNoticeData;
}

export function MessageList({
  messages,
  isLoading,
  conversationId,
  agent,
  onConfirmed,
  onRegenerate,
  onSuggestion,
  onAnswer,
  storedFollowups,
  glances,
  initialBrainSources,
  frames,
  waiting,
}: MessageListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<TurnMetrics | null>(null);
  /**
   * La procedencia del turno recién terminado, que la base ya tiene y esta
   * pestaña todavía no.
   *
   * NO SE GUARDA POR ID, y ésa es la parte que hay que saber: el mensaje que
   * `useChat` acaba de poner en pantalla lleva un id generado en el navegador,
   * no el `uuid` de la fila que `onFinish` escribió. Los dos no coinciden nunca.
   * Por eso esto se aplica al ÚLTIMO mensaje por posición, exactamente igual que
   * las cifras del turno un poco más abajo, y por el mismo motivo.
   */
  const [freshSources, setFreshSources] = useState<BrainSource[] | null>(null);
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
        .then((data: { metrics: TurnMetrics | null; brainSources?: BrainSource[] }) => {
          if (!alive || !data.metrics) return;
          setMetrics(data.metrics);
          // Sólo si hubo algo. Guardar un array vacío pondría una entrada en el
          // mapa, y una entrada con cero fuentes y ninguna entrada tienen que
          // dibujarse igual — que es no dibujar nada.
          const sources = data.brainSources ?? [];
          // Cero fuentes se guarda como `null` y no como `[]`: las dos cosas se
          // dibujan igual —sin nada— y dos maneras de escribir el mismo hecho
          // son dos maneras de que acaben significando cosas distintas. Es la
          // misma regla que defiende la migración 0105.
          setFreshSources(sources.length > 0 ? sources : null);
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

  /**
   * ¿Ya se ancló este hilo en su final? Un ref y no un estado: cambia dentro
   * del efecto que lo lee y no tiene que redibujar nada.
   */
  const landed = useRef(false);
  const threadShown = useRef(conversationId);

  /**
   * Cambiar de hilo es aterrizar otra vez: sin esto, el hilo nuevo hereda el
   * `landed` del anterior y vuelve a abrirse por arriba.
   *
   * De un hilo SIN id a uno con id, no. Ése no es otro hilo: es el mismo, al
   * que el primer turno le acaba de dar dirección — `ChatRoot` cambia la barra
   * del navegador sin desmontar nada, a propósito. Tratarlo como un hilo nuevo
   * arrastraría al fondo a quien estuviera releyendo justo en ese instante, que
   * es exactamente lo que el resto de esto promete no hacer.
   */
  useLayoutEffect(() => {
    const before = threadShown.current;
    threadShown.current = conversationId;
    if (before && conversationId && before !== conversationId) landed.current = false;
  }, [conversationId]);

  /**
   * `useLayoutEffect` y no `useEffect`, que es la mitad del arreglo: corre
   * después de que el DOM está puesto y ANTES de que el navegador pinte, así
   * que el hilo aparece ya en su final en vez de aparecer arriba y saltar. Con
   * `useEffect` el salto es visible aunque el destino sea el mismo, y con un
   * `scrollIntoView` animado se ve además el recorrido entero.
   *
   * Lo que mide la vista se lee del DOM, no de las props, así que `messages` y
   * `isLoading` no aparecen dentro: SON el disparador. `messages` cambia de
   * identidad en cada token —que es justo cuando hay que reevaluar— y su
   * longitud no, así que depender de `messages.length` haría que el
   * seguimiento durante el streaming dejara de correr.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: ver arriba — las dos son el disparador, no valores que el efecto lea.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const intent = scrollIntent(el, { landed: landed.current });
    if (intent === 'stay') return;
    if (intent === 'land') {
      // Asignación directa y no `scrollTo`: es un salto, no un viaje, y ni
      // siquiera llega a pintarse en el sitio de partida.
      el.scrollTop = el.scrollHeight;
      landed.current = true;
      return;
    }
    // Seguir SÍ se anima, porque acompaña contenido que está llegando — salvo
    // que la persona haya pedido que las cosas dejen de moverse. Se lee al
    // vuelo en vez de en el render, como en `_landing/LiveDemo.tsx`: lo que
    // importa es la preferencia en el instante del desplazamiento.
    const still =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    el.scrollTo({ top: el.scrollHeight, behavior: still ? 'auto' : 'smooth' });
  }, [messages, isLoading]);

  const empty = messages.length === 0 && !isLoading;
  const turns = useMemo(() => turnsOf(messages), [messages]);

  /*
    Keep the indicator up while the assistant message exists but has no text
    yet — during tool calls it is empty, and hiding the indicator the moment it
    appears is what left the screen looking blank.

    Se calcula aquí, arriba, porque ahora se dibuja DENTRO del último turno y
    no al final de la lista: ver dónde se monta.
  */
  const live = (() => {
    const last = messages[messages.length - 1];
    const assistantIsSilent = last?.role === 'assistant' && !last.content?.trim();
    if (!isLoading || (last?.role === 'assistant' && !assistantIsSilent)) return null;
    const label = busyLabel(last);
    // Once the reasoning trail is running it is the better progress signal, so
    // the dots stand down — unless a tool is in flight, in which case naming it
    // says something the reasoning does not.
    if (!label && hasReasoning(last)) return null;
    // `counted` cuando hay herramienta: su fila en TaskRows ya lleva el
    // cronómetro, y dos números para la misma espera es la medición duplicada
    // que TaskRows rechaza por escrito. Sin herramienta no cuenta nadie, y ése
    // es justo el silencio que hay que llenar.
    return label ? (
      <LiveStatus state="working" label={label} counted />
    ) : (
      <LiveStatus state="thinking" label="Pensando…" />
    );
  })();

  return (
    <div ref={ref} className="scroll-slim flex-1 overflow-y-auto">
      {empty ? (
        <div className="mx-auto flex h-full w-full max-w-3xl">
          <EmptyState
            agent={agent}
            waiting={waiting}
            onSuggestion={(t) => onSuggestion?.(t)}
            onAsk={(t) => onAnswer?.(t)}
          />
        </div>
      ) : (
        <div className="mx-auto w-full max-w-3xl space-y-11 px-4 py-8 sm:px-6">
          {turns.map((turn) => (
            // 14px por dentro contra los 44px de `space-y-11` que separan los
            // turnos. Ver `turnsOf` para por qué la diferencia es el diseño.
            <article key={turn.key} className="space-y-3.5">
              {turn.at.map((i) => {
                const m = messages[i];
                if (!m) return null;
                const isLast = i === messages.length - 1;
                // The picture belongs to the question; the marks belong to the
                // answer. Walking back to the nearest question is what joins
                // them, and it is done here rather than by keying frames on the
                // answer's id because that id does not exist yet when the frame
                // is taken — it comes back from the server after the turn.
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
                    onAnswer={onAnswer}
                    question={nearestQuestion(messages, i)}
                    storedFollowups={storedFollowups?.[m.id]}
                    glanceAt={glances?.[m.id]}
                    screenFrame={askedWith}
                    delegations={noticePlan[m.id]}
                    brainSources={
                      isLast && freshSources ? freshSources : initialBrainSources?.[m.id]
                    }
                    exercisedMandates={exercised}
                    canRevokeMandates={canRevoke}
                    onMandateRevoked={() => void loadExercised()}
                  />
                );
              })}
              {/* El indicador vive DENTRO del turno que está esperando, a los
                  mismos 14px de la pregunta a los que va a aparecer la
                  respuesta. Fuera de él caía a 44px, así que la presencia
                  saltaba de sitio justo en el momento en que su promesa es que
                  no se sustituye nada: se calma lo que estaba en marcha. */}
              {turn === turns[turns.length - 1] && live}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
