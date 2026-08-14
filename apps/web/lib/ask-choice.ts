import { z } from 'zod';

/**
 * CUANDO CORTEX NO PUEDE SEGUIR SIN QUE ALGUIEN DECIDA.
 *
 * ===========================================================================
 * QUÉ FALTABA, Y QUÉ NO
 * ===========================================================================
 * Parar el turno y esperar una decisión YA ESTABA CONSTRUIDO: una herramienta
 * peligrosa lanza `ConfirmationRequiredError`, `/api/chat` lo convierte en el
 * centinela `__requires_confirmation`, y `ConfirmationPrompt` ofrece confirmar
 * o descartar. Eso resuelve el caso binario de una acción que va a ocurrir.
 *
 * Lo que no existía es la PREGUNTA ABIERTA: «encontré tres clientes que se
 * llaman parecido, ¿cuál?», «¿en pesos o en dólares?», «¿lo mando hoy o el
 * lunes?». Hoy Cortex sólo puede preguntarlo en prosa y esperar a que la
 * persona escriba la respuesta — que funciona, pero deja la decisión sin forma:
 * no se ve que el turno está parado, no se sabe cuáles son las opciones reales,
 * y dos semanas después no se distingue una pregunta de un comentario.
 *
 * ===========================================================================
 * LA LÍNEA QUE ESTA HERRAMIENTA NO CRUZA
 * ===========================================================================
 * **NO ES UNA MANERA DE SALTARSE LAS APROBACIONES, Y NO PUEDE SERLO.**
 *
 * Tres cosas lo sostienen, y la tercera es la única que importa de verdad:
 *
 *   1. NO EJECUTA NADA. `askChoiceResult` es una función pura que devuelve lo
 *      que le dieron. No toca la base, no llama a ningún servicio, no escribe
 *      una fila. Exactamente el mismo argumento que `screen.point_at` en
 *      lib/screen-glance.ts: no hay ninguna acción que auditar.
 *
 *   2. NO ESTÁ EN EL REGISTRO. No se puede conceder con un patrón de agente, no
 *      la puede levantar un mandato, no la clasifica `FAMILY_SENSITIVITY` y no
 *      la ofrece el rankeador. Se declara en `/api/chat` y en ningún otro
 *      sitio, igual que la de señalar.
 *
 *   3. **LA PUERTA SIGUE DONDE ESTABA.** Elegir una opción manda un mensaje de
 *      la persona al hilo. Nada lee esa elección como un permiso: si el modelo
 *      llama después a `gmail.send_message`, `runTool` vuelve a lanzar
 *      `ConfirmationRequiredError` igual que antes, porque la confirmación es
 *      una propiedad de ESA herramienta y de la política de riesgo, no del
 *      estado de la conversación. Es literalmente la arquitectura que
 *      `actions/tools.ts` ya argumenta por escrito («la puerta está donde le
 *      toca») y la que `approvals/tools.ts` defiende negando la existencia de
 *      un `approvals.decide`.
 *
 * Aun así, el sí/no pelado se rechaza aquí abajo — no porque hiciera daño (no
 * lo haría: no autoriza nada), sino porque es la forma en que esto se
 * CONFUNDIRÍA con una aprobación al leerlo. Ver `looksLikeApproval`.
 *
 * ===========================================================================
 * EL OTRO RIESGO, QUE ES DE PRODUCTO
 * ===========================================================================
 * Un modelo con una herramienta de preguntar tiende a preguntar en vez de
 * trabajar. Un agente que pregunta tres veces antes de hacer nada es peor que
 * uno que no pregunta nunca: el segundo al menos avanza y se le corrige. Por
 * eso los límites son duros y están en el código, no sólo en la descripción:
 * dos opciones como mínimo, cinco como máximo, y UNA sola pregunta por turno.
 */

/**
 * CINCO OPCIONES COMO MÁXIMO, Y NO ES UN NÚMERO REDONDO.
 *
 * Por encima de cinco la tarjeta deja de ser una decisión y pasa a ser una
 * lista: se lee en vez de elegirse, y en cuanto se lee, el botón «escribo yo»
 * es más rápido que revisar las siete. Y hay un efecto de segundo orden peor —
 * un tope alto invita al modelo a volcar aquí los resultados de una búsqueda
 * («estos son los 9 clientes») en lugar de acotarla, que es su trabajo.
 *
 * Dos como mínimo por la razón simétrica: una opción no es una decisión, es una
 * confirmación, y las confirmaciones vienen de `ConfirmationRequiredError`.
 */
export const MAX_CHOICE_OPTIONS = 5;
export const MIN_CHOICE_OPTIONS = 2;

/** Lo que cabe en un botón sin que el botón se convierta en un párrafo. */
const MAX_LABEL = 64;
const MAX_DETAIL = 120;
/** Una pregunta, no un informe. El porqué va en la respuesta, encima. */
const MAX_QUESTION = 180;

export const ASK_CHOICE_TOOL_ID = 'ask.choice';

/** El nombre del AI SDK. La misma sustitución que hace la ruta con los ids. */
export const ASK_CHOICE_TOOL_NAME = 'ask_choice';

/**
 * LA DESCRIPCIÓN, QUE ES LA MITAD DEL DISEÑO.
 *
 * Está escrita entera para empujar en contra de usarla. El criterio positivo es
 * uno solo y es concreto —seguir sin la respuesta significaría ACTUAR SOBRE UNA
 * SUPOSICIÓN— y todo lo demás son las cuatro maneras conocidas de abusar de una
 * herramienta así: pedir permiso, confirmar algo ya dicho, preguntar lo que una
 * herramienta puede averiguar, y convertir una charla en un formulario.
 *
 * La última frase es la que más trabajo hace: obliga a comparar contra la
 * alternativa de contestar diciendo qué se supuso, que es casi siempre mejor.
 */
export const ASK_CHOICE_DESCRIPTION = [
  'Ask the person to DECIDE between concrete options, and END YOUR TURN. Use it ONLY when going on',
  'would mean ACTING ON AN ASSUMPTION you cannot check with a tool: several records match the name',
  'and only they know which one, a date or a currency that changes what gets written, which of two',
  'recipients.',
  'DO NOT use it to ask for permission — writes are gated separately and this grants nothing.',
  'DO NOT use it to confirm something the person already told you.',
  'DO NOT use it for anything a tool can find out: look it up instead.',
  'DO NOT use it for open questions — those you simply ask in your answer.',
  `At most ONE per turn, between ${MIN_CHOICE_OPTIONS} and ${MAX_CHOICE_OPTIONS} options, and the`,
  'person can always answer in their own words instead, so never add an "other" option yourself.',
  'Write the question and the options IN SPANISH, short and concrete.',
  'Before you call it, check the alternative: if you can do useful work without the answer, do it',
  'and say plainly what you assumed. That is almost always the better turn.',
].join(' ');

export const AskChoiceSchema = z.object({
  question: z
    .string()
    .min(3)
    .max(MAX_QUESTION)
    .describe('The decision, as one short question in Spanish. Not the reasoning behind it.'),
  options: z
    .array(
      z.object({
        label: z
          .string()
          .min(1)
          .max(MAX_LABEL)
          .describe(
            'What the person is choosing, in a few words. This is what gets sent as their reply.',
          ),
        detail: z
          .string()
          .max(MAX_DETAIL)
          .optional()
          .describe(
            'One short line telling this option apart from the others — a NIT, a city, a date.',
          ),
      }),
    )
    .min(MIN_CHOICE_OPTIONS)
    .max(MAX_CHOICE_OPTIONS)
    .describe('The real alternatives. Never include "other" or "none": that always exists.'),
});

export type AskChoiceInput = z.infer<typeof AskChoiceSchema>;

export interface ChoiceOption {
  label: string;
  detail?: string;
}

/**
 * El sobre que llega al cliente, y el centinela que lo identifica.
 *
 * Mismo mecanismo que `__requires_confirmation`: viaja por el stream de datos
 * como resultado de una llamada, `onFinish` lo escribe en
 * `messages.tool_results`, y `toToolInvocations` lo reconstruye al reabrir la
 * conversación. Por eso una pregunta sin contestar SOBREVIVE A UNA RECARGA sin
 * que haya que guardar nada nuevo en ninguna parte.
 */
export interface AwaitingChoice {
  __awaiting_choice: true;
  question: string;
  options: ChoiceOption[];
  /** Dicho AL MODELO, en su propio turno. Ver `askChoiceResult`. */
  note: string;
}

/** Lo que devuelve cuando la llamada NO se convirtió en pregunta. */
export interface ChoiceRefused {
  __awaiting_choice: false;
  note: string;
}

export type AskChoiceResult = AwaitingChoice | ChoiceRefused;

export function isAwaitingChoice(value: unknown): value is AwaitingChoice {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.__awaiting_choice === true &&
    typeof v.question === 'string' &&
    Array.isArray(v.options) &&
    v.options.length >= MIN_CHOICE_OPTIONS
  );
}

/** Sin tildes, sin puntuación y en minúsculas, para comparar etiquetas. */
function normalize(label: string): string {
  return (
    label
      .normalize('NFD')
      // `\p{M}` y no un rango de combinantes: un rango dentro de una clase de
      // caracteres puede emparejar una letra Y su combinante, que es otra cosa.
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .trim()
  );
}

/** Las dos palabras que convierten una pregunta en una aprobación disfrazada. */
const YES = new Set(['si', 'yes', 'dale', 'ok', 'confirmo', 'adelante', 'hazlo', 'aprobar']);
const NO = new Set(['no', 'cancelar', 'descartar', 'mejor no', 'rechazar']);

/**
 * ¿ESTO ES UNA APROBACIÓN CON OTRO NOMBRE?
 *
 * Exactamente dos opciones, una que dice sí y otra que dice no, y nada más.
 *
 * No se rechaza porque autorizara algo — no lo hace: la elección se convierte en
 * un mensaje de la persona y la puerta de la herramienta peligrosa sigue
 * cerrada. Se rechaza porque SE LEERÍA como una aprobación, y una tarjeta que
 * se lee como una aprobación sin serlo es peor que las dos cosas por separado:
 * enseña a la gente a decidir en una tarjeta que no decide nada, y el día que
 * aparezca la de verdad —ámbar, con el payload desplegable y el botón que sí
 * ejecuta— ya la habrán visto veinte veces y la despacharán igual de rápido.
 *
 * La comparación es por etiqueta COMPLETA y normalizada, nunca por subcadena:
 * «Sí, pero el lunes» y «No antes del cierre» son decisiones de verdad y tienen
 * que pasar.
 */
export function looksLikeApproval(options: readonly ChoiceOption[]): boolean {
  if (options.length !== 2) return false;
  const [a, b] = options.map((o) => normalize(o.label));
  if (!a || !b) return false;
  return (YES.has(a) && NO.has(b)) || (NO.has(a) && YES.has(b));
}

/**
 * QUÉ VUELVE AL TURNO.
 *
 * La nota es la parte que hace que esto funcione, y va dirigida al MODELO y no
 * a la persona. Un resultado de herramienta no termina el turno por sí solo: el
 * modelo recibe el resultado y sigue escribiendo, y lo que estaba escribiendo
 * era la pregunta que ahora está en pantalla en forma de botones. Sin esta
 * frase, la respuesta acaba con la pregunta dicha dos veces —una en la tarjeta
 * y otra en prosa— que es justo la incoherencia que este trabajo venía a
 * quitar.
 *
 * Las dos negativas también hablan al modelo, y por el mismo motivo por el que
 * `pointAtResult` devuelve una nota cuando descarta un rectángulo: una
 * herramienta que falla en silencio deja al modelo creyendo que preguntó, y
 * entonces escribe «cuéntame cuál prefieres» debajo de una tarjeta que no
 * existe. Dicho en voz alta, le quedan pasos de sobra para contestar de otra
 * manera.
 */
export function askChoiceResult(
  input: AskChoiceInput,
  opts: { alreadyAsked: boolean },
): AskChoiceResult {
  if (opts.alreadyAsked) {
    return {
      __awaiting_choice: false,
      note:
        'Ya hay una pregunta esperando en pantalla en este mismo turno y sólo cabe una. ' +
        'No repitas la pregunta: termina aquí y espera a que la persona decida.',
    };
  }

  if (looksLikeApproval(input.options)) {
    return {
      __awaiting_choice: false,
      note:
        'Un sí/no no se pregunta así. Si vas a ejecutar algo, ejecútalo: la herramienta que ' +
        'importa pide su propia confirmación y la persona la aprueba ahí, con el contenido exacto ' +
        'delante. Esta tarjeta es para elegir ENTRE ALTERNATIVAS, no para pedir permiso.',
    };
  }

  return {
    __awaiting_choice: true,
    question: input.question,
    // Copiadas campo por campo, nunca con un spread: lo que sale de aquí se
    // dibuja en pantalla y se guarda en `messages.tool_results`, y un campo de
    // más que el modelo se inventara viajaría hasta los dos sitios.
    options: input.options.map((o) => ({
      label: o.label,
      ...(o.detail ? { detail: o.detail } : {}),
    })),
    note:
      'La pregunta ya está en pantalla con sus botones. TERMINA EL TURNO AQUÍ: no la repitas en ' +
      'texto, no listes las opciones otra vez y no supongas ninguna. La respuesta de la persona ' +
      'llegará como su siguiente mensaje.',
  };
}
