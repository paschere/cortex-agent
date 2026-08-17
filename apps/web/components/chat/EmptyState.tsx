'use client';

import type { FirstStep, Opener, OpenerTone, OpenersResponse } from '@/lib/chat-openers-shape';
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
  PenLine,
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
 * Los mismos cinco tonos de `globals.css`, nada inventado aquí.
 *
 * El icono pasa de ir suelto a ir en su propia baldosa teñida: es lo que hace
 * que seis tarjetas se lean como seis cosas distintas de un vistazo en vez de
 * como una lista, que es justo lo que la selección se esfuerza en conseguir.
 */
const TONE: Record<OpenerTone, { tile: string; dot: string }> = {
  primary: { tile: 'bg-primary-soft text-primary ring-primary/15', dot: 'bg-primary' },
  emerald: { tile: 'bg-emerald-soft text-emerald ring-emerald/15', dot: 'bg-emerald' },
  amber: { tile: 'bg-amber-soft text-amber ring-amber/15', dot: 'bg-amber' },
  sky: { tile: 'bg-sky-soft text-sky ring-sky/15', dot: 'bg-sky' },
  rose: { tile: 'bg-rose-soft text-rose ring-rose/15', dot: 'bg-rose' },
};

/**
 * EL TITULAR, EN PRIMERA PERSONA.
 *
 * Antes decía «Pregúntale a Cortex» y describía el producto desde fuera, como
 * lo diría la página de ventas. Pero el rail entero habla como habla el que
 * trabaja aquí —«Lo que hago solo», «Cómo vamos», «De dónde saco todo»— y esta
 * es la primera frase que alguien lee del producto: si aquí Cortex es «él», en
 * la siguiente pantalla ya es tarde para que sea «yo».
 *
 * Y el titular puede afirmar que ya leyó porque las tarjetas de abajo lo
 * demuestran: nombran el documento, el cliente y la fecha que salieron de este
 * espacio. Cuando no hay nada que leer, el titular cambia entero (ver `blank`),
 * que es la única forma de que esta frase no sea una promesa vacía.
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
 * UNA MANDA Y LAS DEMÁS ACOMPAÑAN.
 *
 * Eran seis tarjetas del mismo tamaño, el mismo peso y el mismo color en una
 * rejilla de dos columnas. Seis cosas idénticas no son seis opciones: son una
 * pared, y el ojo no tiene por dónde entrar. La primera —que es la que el
 * ranking de `pickOpeners` ya considera la mejor, sólo que la pantalla no lo
 * decía— pasa a ocupar el ancho entero, con el texto un paso más grande y la
 * baldosa más alta. Las demás quedan compactas debajo.
 *
 * Y la pregunta pasa de `ink-muted` a `ink`: es el contenido de la tarjeta, no
 * su pie de foto. Estaba escrita en el tono de lo secundario mientras lo único
 * secundario que hay ahí —la procedencia— competía con ella en atención.
 */
function OpenerCard({
  opener,
  index,
  lead = false,
  wide = false,
  onSuggestion,
}: {
  opener: Opener;
  index: number;
  /** La primera: ancho completo y un paso más de tipografía. */
  lead?: boolean;
  /** Un huérfano al final de una rejilla impar, que ocupa las dos columnas. */
  wide?: boolean;
  onSuggestion: (text: string) => void;
}) {
  const Icon = icon(opener.icon);
  const tone = TONE[opener.tone];
  return (
    <button
      type="button"
      // CSS animation, not framer-motion: globals.css already neutralises it
      // under prefers-reduced-motion.
      className={`animate-rise group relative flex items-start gap-3 overflow-hidden rounded-card border border-border bg-surface text-left shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-pop focus-visible:-translate-y-0.5 motion-reduce:transform-none motion-reduce:transition-none ${
        lead ? 'p-4 sm:col-span-2' : 'p-3.5'
      } ${wide ? 'sm:col-span-2' : ''}`}
      style={rise(CARDS_AT_MS + index * STEP_MS)}
      onClick={() => onSuggestion(opener.text)}
    >
      {/* El tinte del hover va en su propia capa y no en un `hover:bg-*` sobre
          la tarjeta: así entra por opacidad —se puede interpolar— en vez de
          cambiar de color de golpe, y no se pelea con `bg-surface`. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-primary-soft opacity-0 transition-opacity duration-200 group-hover:opacity-60 motion-reduce:transition-none"
      />
      <span
        className={`relative grid shrink-0 place-items-center rounded-sm ring-1 ring-inset transition-transform duration-200 group-hover:scale-105 motion-reduce:transform-none motion-reduce:transition-none ${
          lead ? 'h-11 w-11' : 'h-9 w-9'
        } ${tone.tile}`}
      >
        <Icon className={lead ? 'h-5 w-5' : 'h-4 w-4'} aria-hidden />
      </span>
      <span className="relative min-w-0 flex-1 pr-5">
        <span
          className={`block leading-snug text-ink ${lead ? 'text-base font-medium' : 'line-clamp-3 text-sm'}`}
        >
          {opener.text}
        </span>
        {opener.hint ? (
          // La procedencia se dibuja porque es la mitad del valor: una tarjeta
          // que nombra un documento tiene que decir que lo está nombrando, o
          // se lee como una frase de ejemplo más. El punto de color sólo lo
          // llevan las sembradas: distingue «esto existe en tu espacio» de
          // «esto es algo que puedo hacer», que es la distinción que la
          // selección se toma el trabajo de calcular.
          <span className="mt-1.5 flex items-center gap-1.5 text-micro text-ink-faint">
            {opener.kind === 'grounded' ? (
              <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-pill ${tone.dot}`} />
            ) : null}
            <span className="min-w-0 truncate">{opener.hint}</span>
          </span>
        ) : null}
      </span>
      {/* El lápiz dice, sin una línea de texto, que esto ESCRIBE y no manda. */}
      <PenLine
        aria-hidden
        className="absolute right-3 top-3.5 h-3.5 w-3.5 translate-y-0.5 text-primary opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transform-none motion-reduce:transition-none"
      />
    </button>
  );
}

function FirstStepCard({ step, index }: { step: FirstStep; index: number }) {
  const Icon = icon(step.icon);
  return (
    <Link
      href={step.href}
      className="animate-rise group relative flex items-start gap-3 overflow-hidden rounded-card border border-border bg-surface p-3.5 text-left shadow-card transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-pop motion-reduce:transform-none motion-reduce:transition-none"
      style={rise(CARDS_AT_MS + index * STEP_MS)}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-primary-soft opacity-0 transition-opacity duration-200 group-hover:opacity-60 motion-reduce:transition-none"
      />
      <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary ring-1 ring-inset ring-primary/15 transition-transform duration-200 group-hover:scale-105 motion-reduce:transform-none motion-reduce:transition-none">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="relative min-w-0 flex-1">
        <span className="block text-sm font-semibold leading-snug text-ink">{step.label}</span>
        <span className="mt-1 block text-xs leading-snug text-ink-muted">{step.blurb}</span>
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

/**
 * El pie: la garantía, y de dónde salen estas frases.
 *
 * Contar cuántas tarjetas están sembradas no es adorno — es la única prueba en
 * pantalla de que esto no son ejemplos escritos a mano. Y la segunda frase es
 * la postura del componente dicha en voz alta: tocar una tarjeta no manda nada.
 */
function ComposerNote({ grounded, delayMs }: { grounded: number; delayMs: number }) {
  const source =
    grounded === 1
      ? 'Una de estas sale de algo que ya tienes adentro. '
      : grounded > 1
        ? `${grounded} de estas salen de algo que ya tienes adentro. `
        : '';
  return (
    // El lápiz va EN el renglón, no en una columna aparte: con `flex` se queda
    // flotando a la izquierda de un párrafo de dos líneas, que es exactamente el
    // aspecto de un icono puesto por poner.
    <p
      className="animate-rise mt-5 max-w-xl text-balance text-center text-micro leading-snug text-ink-faint"
      style={rise(delayMs)}
    >
      <PenLine className="mr-1.5 inline h-3 w-3 -translate-y-px" aria-hidden />
      {source}Toca la que quieras y te la escribo abajo: tú decides cuándo se manda.
    </p>
  );
}

/**
 * Se intentó y no hay tarjetas. Ni una sola palabra de error, porque puede que
 * no lo haya: un espacio con integraciones conectadas pero sin nada que citar
 * todavía devuelve una lista vacía y no le pasa nada malo. Lo único que este
 * renglón tiene que hacer es señalar el sitio donde sí se puede empezar —la
 * caja de texto de abajo, que manda igual con sugerencias o sin ellas.
 *
 * Cuando además hubo un fallo (red, o el tope de seis segundos), el aviso ámbar
 * de arriba ya lo dijo; esto sigue siendo verdad en los dos casos y no repite.
 */
function NoOpeners() {
  return (
    <p
      className="animate-rise mt-5 max-w-xl text-balance text-center text-micro leading-snug text-ink-faint"
      style={rise(60)}
    >
      <PenLine className="mr-1.5 inline h-3 w-3 -translate-y-px" aria-hidden />
      Hoy no tengo sugerencias que valgan la pena. Escríbeme abajo y arrancamos por ahí.
    </p>
  );
}

export function EmptyState({
  agent,
  onSuggestion,
}: {
  agent?: AgentInfo;
  onSuggestion: (text: string) => void;
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
        // El tope va aquí, en la petición, y no en un temporizador que sólo
        // apague los huecos: una respuesta que llega a los cuarenta segundos y
        // repuebla la pantalla es peor que ninguna. Ver `OPENERS_TIMEOUT_MS`.
        signal: AbortSignal.timeout(OPENERS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error('openers');
      return (await res.json()) as OpenersResponse;
    },
    staleTime: OPENERS_STALE_MS,
    // Una pantalla de bienvenida no puede reintentar tres veces: o llega rápido
    // o no llega, y lo que se dibuja entretanto no cambia.
    retry: false,
    refetchOnWindowFocus: false,
  });

  const data = openers.data;
  const blank = data?.blank ?? false;
  const cards = data?.openers ?? [];
  const grounded = cards.filter((o) => o.kind === 'grounded').length;

  /**
   * Ya no se está esperando y no hay nada que ofrecer.
   *
   * Las tres maneras de llegar aquí terminan en la misma pantalla porque para
   * quien está mirando son el mismo hecho —hoy no hay tarjetas—: la petición
   * falló, la cortó el tope de seis segundos, o llegó bien y venía vacía. Lo
   * que las distingue es el aviso ámbar de arriba, que sólo sale en las dos
   * primeras; ninguna de las tres deja huecos latiendo.
   *
   * Se mira `isLoading` y no `isPending`: con el navegador sin red react-query
   * deja la consulta PAUSADA —pendiente pero sin ir a buscar nada— y esperar a
   * que se resuelva sería otra vez el latido eterno, sólo que por otra puerta.
   */
  const nothingToSuggest = !openers.isLoading && !blank && cards.length === 0;

  return (
    // `safe center` y no `justify-center`: el contenedor de arriba es el que
    // scrollea, y un centrado normal que no cabe reparte el sobrante por los dos
    // lados — o sea, deja la marca y el titular por encima del borde superior,
    // donde no se puede llegar con el dedo. En un teléfono con seis tarjetas eso
    // pasa. `safe` centra sólo mientras quepa y a partir de ahí ancla arriba.
    /*
      ANCLADO ABAJO, NO CENTRADO. Y `chat-sky` se fue.

      Centrado dejaba ~350px de vacío entre la última tarjeta y el compositor:
      en una pantalla de 900px el contenido flotaba en mitad de la nada y la
      caja de texto —lo único que alguien va a tocar aquí— quedaba huérfana al
      fondo. El recorrido correcto de la vista es marca → titular → sugerencias
      → escribir, y termina donde se escribe: así que el bloque se apoya en el
      compositor en vez de flotar lejos de él.

      `safe flex-end` y no `flex-end` a secas, por la misma razón por la que
      antes era `safe center`: cuando el contenido no cabe —seis tarjetas en un
      teléfono— un anclaje normal empuja la marca por encima del borde del
      scroll, donde no se llega. `safe` ancla al principio en cuanto desborda.

      Y `chat-sky` sobraba: era un tercer lavado de índigo encima de la luz de
      `AmbientField`, en la misma pantalla y del mismo color. Dos gradientes
      superpuestos no son el doble de atmósfera, son barro.
    */
    <div className="relative flex flex-1 flex-col items-center px-4 pb-6 pt-8 text-center [justify-content:safe_flex-end] sm:px-6 sm:pt-10">
      <div className="animate-rise mb-7 flex flex-col items-center">
        <Mark />
        <h2 className="mt-5 text-balance text-lg font-bold tracking-tight text-ink sm:text-xl">
          {blank ? BLANK_COPY.title : copy.title}
        </h2>
        <p className="mt-2 max-w-lg text-pretty text-sm leading-snug text-ink-muted">
          {blank ? BLANK_COPY.subtitle : copy.subtitle}
        </p>
      </div>

      {/*
        Un fallo de lectura NUNCA se dibuja como un espacio vacío. «No tienes
        documentos» y «no pude leer tus documentos» son dos frases distintas, y
        sólo una de las dos manda a alguien a subir de nuevo algo que ya está.
      */}
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

      {/*
        UNA COLUMNA CUANDO SON LOS PRIMEROS PASOS, DOS CUANDO SON SUGERENCIAS.

        Los primeros pasos son TRES, y tres en una rejilla de dos columnas deja
        una huérfana sola a la izquierda con un hueco al lado — que no se lee
        como «tres cosas», se lee como una tarjeta que no cargó. Además no son
        alternativas entre las que elegir una: son tres cosas que hay que hacer,
        y una columna es la forma de una lista de tareas.

        Las sugerencias sí son alternativas —eliges una y descartas cinco— y
        para eso la rejilla es correcta; ahí el huérfano ya lo resuelve `wide`.
      */}
      <div className={`grid w-full max-w-3xl grid-cols-1 gap-2 ${blank ? '' : 'sm:grid-cols-2'}`}>
        {blank
          ? (data?.firstSteps ?? []).map((step, i) => (
              <FirstStepCard key={step.id} step={step} index={i} />
            ))
          : cards.map((opener, i) => (
              <OpenerCard
                key={opener.id}
                opener={opener}
                index={i}
                lead={i === 0}
                // El último de una cola impar ocuparía media fila y dejaría un
                // hueco al lado, que se lee como una tarjeta que faltó cargar.
                wide={i > 0 && i === cards.length - 1 && cards.length % 2 === 0}
                onSuggestion={onSuggestion}
              />
            ))}
        {/*
          Mientras llega la respuesta no se dibujan tarjetas de relleno con
          texto falso: son seis frases que alguien va a leer, y leer una frase
          inventada y verla cambiar es peor que esperar dos décimas. El latido
          va desfasado tarjeta a tarjeta para que se lea como algo cargando y
          no como cuatro cajas parpadeando al unísono.
        */}
        {openers.isLoading
          ? [0, 1, 2, 3].map((i) => (
              <div
                key={i}
                // El primero ancho, como la tarjeta que va a ocupar su sitio:
                // si el hueco no tiene la forma del contenido, la pantalla da
                // un salto al llegar los datos.
                className={`animate-pulse rounded-card border border-border bg-surface-2 ${
                  i === 0 ? 'h-[86px] sm:col-span-2' : 'h-[74px]'
                }`}
                style={rise(i * 140)}
              />
            ))
          : null}
      </div>

      {!blank && cards.length > 0 ? (
        <ComposerNote grounded={grounded} delayMs={CARDS_AT_MS + cards.length * STEP_MS + 60} />
      ) : nothingToSuggest ? (
        <NoOpeners />
      ) : null}
    </div>
  );
}
