'use client';

import { usePanel } from '@/components/panel/PanelHost';
import type { FirstStep, OpenersResponse } from '@/lib/chat-openers-shape';
import { panelForWaiting } from '@/lib/waiting-panel';
import { type WaitingNoticeData, clipTitle, waitingQuestion } from '@/lib/waiting-shape';
import { useQuery } from '@tanstack/react-query';
import {
  AlarmClock,
  BarChart3,
  Brain,
  Building2,
  CalendarClock,
  CalendarDays,
  Car,
  FileText,
  GitBranch,
  Globe,
  Handshake,
  Inbox,
  Mic,
  Plug,
  Send,
  Sparkles,
  Telescope,
  TriangleAlert,
  Upload,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';

/**
 * LA PRIMERA PANTALLA, SEMBRADA CON LO QUE ESTA EMPRESA TIENE.
 *
 * Antes había seis tarjetas escritas a mano que no miraban nada: le proponían
 * consultar el RUNT a un espacio sin ese servicio configurado y preguntar por
 * la última llamada a uno que nunca grabó una. Ahora las tarjetas nombran el
 * documento que subieron ayer, el cliente por su nombre y el vencimiento que
 * está más cerca — y sólo aparecen si la herramienta que las contesta se puede
 * ejecutar de verdad.
 *
 * Las reglas están en `lib/chat-openers-shape.ts` y las filas las junta
 * `/api/chat/openers`. Aquí sólo se dibuja. CERO llamadas al modelo: una
 * petición cacheada cinco minutos, y nada más.
 *
 * Al hacer clic la frase se ESCRIBE en el compositor, no se manda. La primera
 * pregunta de alguien merece poder retocarse antes de salir, y una tarjeta que
 * dispara un turno al primer clic es una tarjeta que da miedo tocar. Eso antes
 * sólo estaba escrito en este comentario; ahora la pantalla lo dice en voz alta
 * —el pie y el lápiz que asoma al pasar por encima— porque una garantía que
 * nadie ve no tranquiliza a nadie.
 *
 * ---------------------------------------------------------------------------
 * POR QUÉ SE MUEVE, Y CUÁNDO PARA
 * ---------------------------------------------------------------------------
 * Esta pantalla se abre todos los días, varias veces. Así que el movimiento es
 * casi todo de ENTRADA y se acaba solo: la marca, el titular, el aviso, las
 * tarjetas y el pie suben escalonados con `animate-rise` y a los ~450 ms la
 * pantalla está quieta. Lo único que sigue después es la luz de detrás de la
 * marca (`cx-glow` en `globals.css`): siete segundos, muy poco recorrido y
 * desenfocada, para que se note que hay alguien ahí sin dar nada que mirar.
 *
 * El anillo que sale de la marca al montar es `kb-flare`, la misma pieza que
 * usa el mapa de memoria: se expande dos veces y para. Se apoya en `opacity-0`
 * como estado de reposo, así que cuando la animación termina —o cuando
 * `prefers-reduced-motion` la corta en seco— no queda un aro dibujado encima.
 *
 * `prefers-reduced-motion` apaga las tres cosas: la regla global de
 * `globals.css` neutraliza las duraciones y aquí además va `motion-reduce:` en
 * cada transformación, que es lo que evita que quede una tarjeta a medio subir.
 */

interface AgentInfo {
  slug: string;
  name: string;
  greeting: string;
}

const ICONS: Record<string, typeof Brain> = {
  AlarmClock,
  BarChart3,
  Building2,
  CalendarClock,
  CalendarDays,
  Car,
  FileText,
  GitBranch,
  Globe,
  Handshake,
  Inbox,
  Mic,
  Plug,
  Send,
  Sparkles,
  Telescope,
  Upload,
  Wallet,
};

function icon(name: string): typeof Brain {
  return ICONS[name] ?? Sparkles;
}

/**
 * EL TITULAR, EN PRIMERA PERSONA.
 *
 * El rail entero habla como habla el que trabaja aquí, y ésta es la primera
 * frase que alguien lee del producto: si aquí Cortex es «él», en la siguiente
 * pantalla ya es tarde para que sea «yo». Cuando hay algo esperándote, la
 * frase del día es esa — no un catálogo de seis tarjetas.
 */
const CORTEX_COPY = {
  title: 'Ya leí lo tuyo. Pregúntame.',
  subtitle:
    'Tus correos, tus contratos, tus reuniones y lo que se te vence. Te contesto con eso y te digo de dónde salió cada dato.',
};

const COPY: Record<string, { title: string; subtitle: string }> = { cortex: CORTEX_COPY };

/** El espacio recién creado. También en primera persona, y sin fingir nada. */
const BLANK_COPY = {
  title: 'Todavía no tengo nada tuyo que leer',
  subtitle:
    'Contesto con lo que tenga tu empresa adentro, y este espacio está recién creado. Empieza por aquí y la próxima vez abro esta pantalla con preguntas sacadas de tus propios documentos.',
};

/** Cinco minutos: lo que tarda en aparecer un documento subido en otra pestaña. */
const OPENERS_STALE_MS = 5 * 60 * 1000;

/**
 * EL LATIDO TIENE FINAL, Y ÉSTE ES.
 *
 * Los cuatro huecos que pulsan mientras llegan las sugerencias no tenían tope:
 * `fetch` no caduca solo, así que una petición que se quedaba colgada —proxy
 * que no cierra, red que se cae con la conexión abierta, servidor que acepta y
 * no contesta— dejaba `isLoading` en verdadero para siempre y la primera
 * pantalla del producto pulsando indefinidamente. No es un caso de laboratorio:
 * es lo que se ve al abrir el chat con el teléfono cambiando de wifi a datos.
 *
 * Seis segundos, y el número sale de lo que hay al otro lado: `/api/chat/openers`
 * son nueve lecturas ACOTADAS a Supabase —todas por índice y con `limit` de un
 * dígito— lanzadas en paralelo, más una constante compilada. Eso contesta en
 * décimas incluso con la conexión fría; seis segundos es un margen tan ancho
 * que sólo se agota cuando algo está de verdad atascado, y no tan ancho como
 * para que alguien se quede mirando huecos hasta aburrirse.
 *
 * Se corta la PETICIÓN y no sólo el dibujo, que es la diferencia entre resolver
 * esto y taparlo: al abortar, react-query pasa a error, los huecos desaparecen
 * y aparece el aviso de abajo — la misma salida que ya tenía el error de red,
 * porque para quien está mirando es exactamente el mismo hecho.
 */
const OPENERS_TIMEOUT_MS = 6_000;

/**
 * La escalera de entrada, en un sitio y no repartida por seis `style`.
 *
 * Primero la marca, después el aviso, después las tarjetas de una en una y al
 * final el pie. 55 ms entre tarjetas es lo justo para que se lea como una mano
 * repartiendo y no como seis cosas cayendo a la vez; con seis tarjetas la
 * pantalla queda quieta antes de medio segundo.
 */
const STEP_MS = 55;
const CARDS_AT_MS = 120;
const rise = (delayMs: number) => ({ animationDelay: `${delayMs}ms` });

/**
 * LA PREGUNTA DEL DÍA, EN UNA LÍNEA.
 *
 * Ya no es un catálogo. Una sola frase, escrita no mandada, y el compositor
 * debajo. Si hay algo esperándote, esa frase es la de las colas — no una
 * tarjeta de más encima del titular.
 */
function SuggestionLine({
  text,
  hint,
  onSuggestion,
}: {
  text: string;
  hint?: string;
  onSuggestion: (text: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSuggestion(text)}
      className="animate-rise group max-w-lg text-pretty text-center"
      style={rise(80)}
    >
      <span className="text-sm leading-snug text-ink-muted underline decoration-border underline-offset-4 transition-colors duration-150 group-hover:text-ink group-hover:decoration-primary/40 motion-reduce:transition-none">
        {text}
      </span>
      {hint ? <span className="mt-1.5 block text-micro text-ink-faint">{hint}</span> : null}
    </button>
  );
}

function FirstStepCard({ step, index }: { step: FirstStep; index: number }) {
  const Icon = icon(step.icon);
  return (
    <Link
      href={step.href}
      className="animate-rise group flex items-start gap-3 px-1 py-2 text-left"
      style={rise(CARDS_AT_MS + index * STEP_MS)}
    >
      <span className="relative mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary ring-1 ring-inset ring-primary/15">
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-snug text-ink group-hover:text-primary">
          {step.label}
        </span>
        <span className="mt-0.5 block text-xs leading-snug text-ink-muted">{step.blurb}</span>
      </span>
    </Link>
  );
}

/**
 * La marca: un cerebro con luz detrás.
 *
 * Tres capas y cada una hace una cosa. El halo desenfocado es lo único que
 * sigue moviéndose pasada la entrada. El anillo (`kb-flare`) sale una vez al
 * montar y desaparece — su reposo es `opacity-0`, así que ni al terminar ni con
 * `prefers-reduced-motion` queda un aro pegado encima. La baldosa va en blanco
 * y no en índigo suave a propósito: con luz detrás, un relleno teñido apaga el
 * halo en vez de dejarlo pasar.
 */
function Mark() {
  return (
    <span className="relative grid h-14 w-14 place-items-center">
      <span
        aria-hidden
        className="cx-glow absolute -inset-5 rounded-pill bg-primary/25 opacity-55 blur-2xl motion-reduce:animate-none"
      />
      <span
        aria-hidden
        className="kb-flare absolute inset-0 rounded-card opacity-0 ring-2 ring-primary/40 motion-reduce:hidden"
      />
      <span className="relative grid h-14 w-14 place-items-center rounded-card bg-surface text-primary shadow-card ring-1 ring-inset ring-primary/15">
        <Brain className="h-6 w-6" />
      </span>
    </span>
  );
}

export function EmptyState({
  agent,
  waiting,
  onSuggestion,
  onAsk,
}: {
  agent?: AgentInfo;
  waiting?: WaitingNoticeData;
  onSuggestion: (text: string) => void;
  onAsk?: (text: string) => void;
}) {
  const copy = (agent && COPY[agent.slug]) ?? {
    title: agent?.name ?? CORTEX_COPY.title,
    subtitle: agent?.greeting ?? CORTEX_COPY.subtitle,
  };

  const slug = agent?.slug ?? '';
  const openers = useQuery<OpenersResponse>({
    queryKey: ['chat-openers', slug],
    queryFn: async () => {
      const res = await fetch(`/api/chat/openers?agent=${encodeURIComponent(slug)}`, {
        signal: AbortSignal.timeout(OPENERS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error('openers');
      return (await res.json()) as OpenersResponse;
    },
    staleTime: OPENERS_STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const data = openers.data;
  const blank = data?.blank ?? false;
  const cards = data?.openers ?? [];
  const suggestion = !blank ? cards[0] : undefined;
  const waitingOn = waiting && waiting.total > 0;
  const lead = waitingOn ? waiting.lead : null;
  const { open, available } = usePanel();
  const waitingPanel = waitingOn && !lead && available ? panelForWaiting(waiting.queues) : null;
  const title = blank
    ? BLANK_COPY.title
    : lead
      ? clipTitle(lead.title, 90)
      : waitingOn
        ? (waiting?.sentence ?? '')
        : copy.title;

  const askWaiting = () => {
    if (lead) (onAsk ?? onSuggestion)(lead.ask);
    else if (waitingPanel) open(waitingPanel);
    else if (waitingOn && waiting) (onAsk ?? onSuggestion)(waitingQuestion(waiting.queues));
  };

  return (
    <div className="relative flex flex-1 flex-col items-center px-4 pb-8 pt-8 text-center [justify-content:safe_flex-end] sm:px-6 sm:pt-10">
      <div className="animate-rise mb-6 flex flex-col items-center">
        <Mark />
        {waitingOn ? (
          <button
            type="button"
            onClick={askWaiting}
            className="mt-6 max-w-xl text-balance text-2xl font-semibold tracking-tight text-ink underline decoration-amber/40 underline-offset-8 transition-colors hover:decoration-amber sm:text-[1.75rem]"
          >
            {title}
          </button>
        ) : (
          <h2 className="mt-6 max-w-xl text-balance text-2xl font-semibold tracking-tight text-ink sm:text-[1.75rem]">
            {title}
          </h2>
        )}
        <p className="mt-2 max-w-md text-pretty text-sm leading-relaxed text-ink-muted">
          {blank
            ? BLANK_COPY.subtitle
            : lead
              ? (waiting?.sentence ?? '')
              : waitingOn
                ? 'Tócalo y lo abro al lado, sin salir de aquí.'
                : copy.subtitle}
        </p>
        {lead ? (
          <button
            type="button"
            onClick={askWaiting}
            className="mt-3 text-sm font-semibold text-amber underline decoration-amber/40 underline-offset-4 transition-colors hover:decoration-amber"
          >
            {lead.ask}
          </button>
        ) : null}
      </div>

      {data?.notice || openers.isError ? (
        <p
          className="animate-rise mb-4 flex max-w-xl items-start gap-2 rounded-sm border border-amber/25 bg-amber-soft px-3 py-2 text-left text-xs leading-snug text-ink-muted"
          style={rise(60)}
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" aria-hidden />
          <span>
            {data?.notice ??
              'No pude armar sugerencias con tus datos ahora mismo. Pregúntame igual, que el chat funciona.'}
          </span>
        </p>
      ) : null}

      {blank ? (
        <div className="w-full max-w-md text-left">
          {(data?.firstSteps ?? []).map((step, i) => (
            <FirstStepCard key={step.id} step={step} index={i} />
          ))}
        </div>
      ) : waitingOn ? null : suggestion ? (
        <SuggestionLine
          text={suggestion.text}
          hint={suggestion.hint ?? undefined}
          onSuggestion={onSuggestion}
        />
      ) : openers.isLoading ? (
        <div
          className="h-4 w-48 animate-pulse rounded-pill bg-surface-2 motion-reduce:animate-none"
          aria-hidden
        />
      ) : null}
    </div>
  );
}
