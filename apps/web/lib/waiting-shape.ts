/**
 * LA FRASE DE ARRIBA, Y POR QUÉ NO LA ESCRIBE UN MODELO.
 *
 * Cortex trabaja de noche —los crons de vencimientos, de acciones y de encargos
 * dejan cosas hechas— y hasta ahora eso vivía repartido en cuatro pantallas que
 * nadie abre sin motivo. El índice de /dashboard las reúne, y encima de él va
 * una sola línea en español que dice cuánto hay y qué es lo peor.
 *
 * ESA LÍNEA ES UNA FUNCIÓN PURA DE LOS NÚMEROS, a propósito y para siempre.
 * Es la frase del día en un chat vacío, y el aviso del rail. Se dibuja en cada
 * carga, para todo el mundo. Pedírsela a un modelo costaría una llamada por
 * visita, tardaría segundos en la primera pintura y —lo que de verdad importa—
 * daría una frase distinta cada vez para los mismos datos, así que nadie podría
 * comprobar que dice la verdad. Aquí las mismas entradas dan siempre la misma
 * oración, y el archivo de al lado la prueba caso por caso.
 *
 * NADA DE ESTE ARCHIVO TOCA LA BASE NI IMPORTA `@cortex/agent-tools`. El aviso
 * del chat es un componente de cliente, así que la frase tiene que poder
 * calcularse y tipearse a los dos lados; el barril de agent-tools alcanza
 * `node:dns` y rompería el build del navegador. La misma razón por la que
 * existen `actions-shape.ts` y `commitments-shape.ts`.
 */

export const WAITING_QUEUES = ['approvals', 'commitments', 'actions', 'errands'] as const;
export type WaitingQueue = (typeof WAITING_QUEUES)[number];

/**
 * Las cuatro colas, contadas. Es la forma exacta que devuelve
 * `countNavSignals`, que es de donde salen: el índice no cuenta por su cuenta,
 * reutiliza el conteo que ya dibuja el badge del menú, para que la frase y el
 * número de la barra lateral no puedan discrepar.
 */
export interface WaitingCounts {
  approvals: number;
  commitments: number;
  actions: number;
  errands: number;
}

/**
 * Lo que la frase sabe. Los conteos son obligatorios; los dos hechos afilados
 * son opcionales por diseño.
 *
 * `oldestDays` y `overdue` sólo se conocen cuando alguien leyó el CONTENIDO de
 * las colas, y hay una superficie que no lo hace: el aviso del chat se conforma
 * con los conteos porque abrir una conversación nueva no puede costar cuatro
 * lecturas de listas. Con `oldestDays: null` y `overdue: 0` la frase se queda en
 * la cabeza —«Tres cosas te esperan.»— que es verdad y es suficiente.
 */
export interface WaitingFacts {
  counts: WaitingCounts;
  /** De los vencimientos contados arriba, cuántos ya se pasaron de fecha. */
  overdue: number;
  /** Días que lleva esperando lo más antiguo de las cuatro colas. */
  oldestDays: number | null;
  /** A qué cola pertenece eso más antiguo. */
  oldestQueue: WaitingQueue | null;
}

/**
 * A partir de cuántos días la espera es noticia.
 *
 * Algo que llegó ayer no es un hallazgo, es el trabajo del día. Tres días
 * significa que ya pasó un ciclo completo de los crons nocturnos y nadie lo
 * miró, que es justo el silencio que esta pantalla existe para romper.
 */
export const STALE_DAYS = 3;

export const QUEUE_LABEL: Record<WaitingQueue, string> = {
  approvals: 'Aprobaciones',
  commitments: 'Vencimientos',
  actions: 'Acciones',
  errands: 'Encargos',
};

export const QUEUE_HREF: Record<WaitingQueue, string> = {
  approvals: '/approvals',
  commitments: '/commitments',
  actions: '/actions',
  errands: '/errands',
};

/**
 * Lo que cada cola promete cuando está vacía. Es la única prosa del índice, y
 * dice qué DEJARÍA ahí Cortex, no qué es la pantalla.
 */
export const QUEUE_EMPTY: Record<WaitingQueue, string> = {
  approvals: 'Nada esperando permiso.',
  commitments: 'Ningún vencimiento encima.',
  actions: 'Ningún correo redactado sin mandar.',
  errands: 'Ningún encargo atascado.',
};

/**
 * LO QUE SE PREGUNTA AL TOCAR EL AVISO — PORQUE YA SE ESTÁ EN EL SITIO DONDE
 * SE PREGUNTA.
 *
 * El aviso del chat enlazaba a `/dashboard`: te decía que hay tres cosas
 * esperando y te sacaba del chat a mirarlas. Eso es exactamente al revés en la
 * única pantalla del producto que sabe contestar — la persona ya está delante
 * del sitio donde se pregunta, así que el aviso ejecuta el turno en vez de
 * navegar.
 *
 * LA PREGUNTA SE AJUSTA A LO QUE HAY. Con una sola cola llena se pregunta por
 * esa cola, con su vocabulario: preguntar «¿qué espera mi aprobación?» cuando
 * lo único pendiente es un encargo atascado devuelve «nada», que es verdad y es
 * inútil. Con varias, la pregunta se abre y deja que Cortex mire las que sean.
 */
export const QUEUE_QUESTION: Record<WaitingQueue, string> = {
  approvals: '¿Qué espera mi aprobación?',
  commitments: '¿Qué vencimientos tengo encima?',
  actions: '¿Qué correos tienes redactados y sin mandar?',
  errands: '¿Cómo van mis encargos?',
};

export const ANY_QUEUE_QUESTION = '¿Qué está esperando algo de mí?';

/** La pregunta que corresponde a este aviso. Pura, como la frase. */
export function waitingQuestion(queues: ReadonlyArray<{ queue: WaitingQueue }>): string {
  const first = queues[0];
  if (queues.length === 1 && first) return QUEUE_QUESTION[first.queue];
  return ANY_QUEUE_QUESTION;
}

/**
 * El sí de cada cola, con el asunto ya puesto.
 *
 * «Tres cosas te esperan» es un conteo. «¿Le escribo por Cotización Andina?»
 * es una decisión. El chat vacío tiene que ofrecer la segunda, o sigue siendo
 * un índice que se lee y no se contesta.
 */
const QUEUE_YES: Record<WaitingQueue, (title: string) => string> = {
  approvals: (title) => `¿Apruebo «${title}»?`,
  commitments: (title) => `¿Le escribo por «${title}»?`,
  actions: (title) => `¿Mando «${title}»?`,
  errands: (title) => `¿Te contesto lo que te preguntó sobre «${title}»?`,
};

/** Recorta un asunto para que quepa en una pregunta de un renglón. */
export function clipTitle(title: string, max = 72): string {
  const trimmed = title.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** El sí que corresponde a esta cola y este asunto. Pura, como la frase. */
export function briefingAsk(queue: WaitingQueue, title: string): string {
  return QUEUE_YES[queue](clipTitle(title));
}

/**
 * El mismo briefing, en texto. WhatsApp no pinta tarjetas; el vacío del chat
 * sí. Las dos superficies tienen que decir la misma cosa, y esta función es
 * esa cosa: nombre, frase, pregunta. Sin modelo.
 */
export function briefingLetter(waiting: WaitingNoticeData): string | null {
  if (waiting.total <= 0) return null;
  if (waiting.lead) {
    const lines = [clipTitle(waiting.lead.title, 90), waiting.sentence, waiting.lead.ask];
    if (waiting.lead.detail) lines.splice(1, 0, waiting.lead.detail);
    lines.push('Responde «sí» y lo hago.');
    return lines.join('\n\n');
  }
  return `${waiting.sentence}\n\nResponde «sí» y lo abro.`;
}

/** Un «sí» de una palabra. Cualquier otra cosa es una pregunta de verdad. */
export function isWaitingYes(text: string): boolean {
  return /^(sí|si|yes|dale|claro|ok|okay|vale|hazlo|adelante|listo|manda|mándalo|mandalo|escríbele)[.!¡]?$/i.test(
    text.trim(),
  );
}

/** Un saludo y nada más. «Hola, ¿cuánto debe Coltrans?» no es un saludo. */
export function isGreeting(text: string): boolean {
  return /^(hola|holi|buenas|hey|buenos días|buenas tardes|buenas noches|buen día|qué más|q mas)[.!¡,]?$/i.test(
    text.trim(),
  );
}

export type WhatsappBriefingGate = 'brief' | 'yes' | 'run';

/**
 * Qué hace WhatsApp con este mensaje, mirando las colas — no el modelo.
 *
 * Un saludo con trabajo pendiente es el briefing. Un sí es el turno. Todo lo
 * demás corre como siempre: la persona preguntó algo.
 */
export function whatsappBriefingGate(
  text: string,
  waiting: Pick<WaitingNoticeData, 'total'> & { lead?: WaitingLead | null },
): WhatsappBriefingGate {
  if (waiting.total <= 0) return 'run';
  if (isWaitingYes(text)) return 'yes';
  if (isGreeting(text)) return 'brief';
  return 'run';
}

/**
 * Lo primero que hay que hacer, con nombre propio.
 *
 * Lo carga el aviso del chat con UNA lectura extra —el primer elemento de la
 * primera cola que no está vacía—, no las cuatro listas del índice. Ausente
 * cuando no hay nada o cuando esa lectura falló: la frase del conteo sigue
 * siendo verdad.
 */
export interface WaitingLead {
  queue: WaitingQueue;
  title: string;
  detail: string | null;
  /** «¿Le escribo por Cotización Andina?» */
  ask: string;
}

/** Lo que el chat necesita saber: la frase, el total y a dónde ir. */
export interface WaitingNoticeData {
  total: number;
  sentence: string;
  /** Sólo las colas que tienen algo dentro, en el orden de WAITING_QUEUES. */
  queues: Array<{ queue: WaitingQueue; label: string; href: string; count: number }>;
  /** El primer asunto, cuando se pudo leer. */
  lead?: WaitingLead | null;
}

export function waitingTotal(counts: WaitingCounts): number {
  return (
    safe(counts.approvals) + safe(counts.commitments) + safe(counts.actions) + safe(counts.errands)
  );
}

/** Un conteo que llegó raro no puede envenenar la suma. */
function safe(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Los números pequeños se escriben con letra, como los escribiría una persona.
 * Del trece en adelante vuelven a ser cifras: «veintitrés cosas te esperan» se
 * lee peor que «23 cosas te esperan».
 *
 * Uno es «una» porque todo lo que cuenta esta frase es femenino —cosas— y
 * porque la única otra aparición del uno («una ya se venció») también lo es.
 * Los días se arman aparte, en `dayPhrase`, que sí es masculino.
 */
const CARDINAL = [
  'cero',
  'una',
  'dos',
  'tres',
  'cuatro',
  'cinco',
  'seis',
  'siete',
  'ocho',
  'nueve',
  'diez',
  'once',
  'doce',
];

function cardinal(n: number): string {
  return CARDINAL[n] ?? String(n);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * «un día» / «nueve días» / «23 días».
 *
 * Una fecha ilegible no puede acabar escrita en la pantalla como «hace NaN
 * días»: un número roto se cuenta como cero y la frase que lo contiene ya no
 * se dibuja, porque cero días nunca cruza STALE_DAYS.
 */
export function dayPhrase(days: number): string {
  const n = Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0;
  if (n === 1) return 'un día';
  return `${cardinal(n)} días`;
}

/**
 * Cuánto hace que pasó algo, dicho como se dice en voz alta.
 *
 * `relative-time.ts` da «hace 9d» y a partir de la semana pasa a una fecha, que
 * es lo correcto para una tabla y lo contrario de lo que quiere una ficha que
 * intenta que a alguien le duela el número: «redactada hace nueve días» es la
 * línea que hace abrir la cola. Por eso esta versión no se rinde nunca a la
 * fecha y escribe los días con letra.
 */
export function agoPhrase(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs)) return 'hace un momento';
  const ms = Math.max(0, elapsedMs);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'hace un momento';
  if (minutes < 60) return minutes === 1 ? 'hace un minuto' : `hace ${cardinal(minutes)} minutos`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'hace una hora' : `hace ${cardinal(hours)} horas`;
  return `hace ${dayPhrase(Math.floor(hours / 24))}`;
}

/**
 * La frase de arriba.
 *
 * Estructura fija: una cabeza que cuenta, y como mucho dos coletillas que
 * dicen lo peor. Las coletillas van en orden de gravedad —una fecha que ya se
 * pasó antes que un borrador que envejece— y nunca se dicen dos cosas del mismo
 * objeto: si lo único que espera es el único vencimiento vencido, la frase lo
 * menciona una vez.
 *
 *   No hay nada esperándote.
 *   Cinco cosas te esperan.
 *   Tres cosas te esperan y una lleva nueve días.
 *   Una cosa te espera y lleva nueve días.
 *   Once cosas te esperan: dos ya se vencieron y una lleva doce días.
 */
export function summarizeWaiting(facts: WaitingFacts): string {
  const total = waitingTotal(facts.counts);
  if (total === 0) return 'No hay nada esperándote.';

  const head = `${capitalize(cardinal(total))} ${total === 1 ? 'cosa te espera' : 'cosas te esperan'}`;

  const oldest = facts.oldestDays;
  const aged = oldest !== null && Number.isFinite(oldest) && oldest >= STALE_DAYS;
  const ageTail = aged
    ? total === 1
      ? `lleva ${dayPhrase(oldest as number)}`
      : `una lleva ${dayPhrase(oldest as number)}`
    : null;

  const overdue = safe(facts.overdue);
  let overdueTail: string | null = null;
  if (overdue > 0) {
    if (total === 1) overdueTail = 'ya se venció';
    else if (overdue === 1) overdueTail = 'una ya se venció';
    else overdueTail = `${cardinal(overdue)} ya se vencieron`;
  }

  // Una sola cosa esperando no merece dos oraciones sobre sí misma, y de las
  // dos la edad dice más: «ya se venció» ya se deduce de «lleva nueve días».
  if (total === 1 && ageTail) overdueTail = null;
  // Y si lo más viejo de todo ES el único vencimiento pasado de fecha, contarlo
  // dos veces haría creer que son dos cosas distintas.
  if (overdue === 1 && facts.oldestQueue === 'commitments' && ageTail) overdueTail = null;

  const tails = [overdueTail, ageTail].filter((t): t is string => t !== null);
  if (tails.length === 0) return `${head}.`;
  if (tails.length === 1) return `${head} y ${tails[0]}.`;
  return `${head}: ${tails[0]} y ${tails[1]}.`;
}

/** El aviso del chat, armado sólo con los conteos. Ver `WaitingFacts`. */
export function noticeFromCounts(counts: WaitingCounts): WaitingNoticeData {
  return {
    total: waitingTotal(counts),
    sentence: summarizeWaiting({ counts, overdue: 0, oldestDays: null, oldestQueue: null }),
    queues: WAITING_QUEUES.filter((q) => safe(counts[q]) > 0).map((q) => ({
      queue: q,
      label: QUEUE_LABEL[q],
      href: QUEUE_HREF[q],
      count: safe(counts[q]),
    })),
  };
}
