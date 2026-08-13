import { z } from 'zod';

/**
 * EL CATÁLOGO, Y POR QUÉ ES UNA LISTA CERRADA Y NO UN PROMPT
 * ===========================================================================
 *
 * La entrevista de puesta en marcha le pide a un modelo que traduzca «así
 * funciona mi empresa» a cosas configuradas dentro de Cortex. El modo de fallar
 * de eso no es que proponga poco: es que proponga algo que suena perfecto y que
 * el producto no sabe hacer. «Te dejo alertas por WhatsApp cuando un contenedor
 * cambie de estado en el puerto» es una frase que cierra ventas y que, si nadie
 * la sostiene, convierte la primera pantalla del producto en la primera mentira
 * del producto.
 *
 * Un prompt no puede impedir eso, porque un prompt es una petición. Este
 * archivo sí, porque es un FILTRO: todo lo que el modelo devuelve pasa por
 * `normalizeProposal`, que sólo conoce cinco tipos y sólo acepta los campos que
 * el módulo de destino exige. Lo que no encaja no se muestra en gris ni se
 * marca como "pendiente": no llega a existir como propuesta, y lo que la
 * persona pidió se guarda tal cual dijo en `outOfScope`, con la respuesta
 * honesta —«eso todavía no lo puedo hacer solo»— en vez de una configuración
 * que aparenta resolverlo.
 *
 * TRES BUCKETS, NO DOS
 * ---------------------------------------------------------------------------
 * La división obvia es "lo puedo hacer / no lo puedo hacer" y es demasiado
 * gruesa, porque deja fuera el caso más común: cosas que el producto SÍ hace
 * pero que no se configuran escribiendo. Un trámite se aprende grabando el
 * portal una vez; un encargo se encarga, no se configura; una fuente se conecta
 * con OAuth. Meter esos tres en "no puedo" sería mentir por defecto, y meterlos
 * en "puedo" sería peor: generaría filas vacías que alguien tendría que
 * limpiar. Así que van en un tercer bucket, `handoff`: se reconocen, se nombran
 * y se entrega el enlace donde una persona lo hace de verdad. No se crea nada.
 *
 *   create   Cinco tipos. Se proponen con sus campos exactos y, si alguien
 *            confirma, se crean en su módulo de siempre.
 *   handoff  Tres destinos. Se reconocen y se enlazan. Cero filas escritas.
 *   scope    Todo lo demás. Se anota literal y se dice que no.
 *
 * NO IMPORTA `@cortex/agent-tools` — Y NO ES UN DESCUIDO
 * ---------------------------------------------------------------------------
 * Este módulo lo lee la pantalla, que es `'use client'`. Importar el barril de
 * agent-tools desde el cliente arrastra `node:dns` y rompe el build de
 * producción sin que typecheck ni los tests digan nada. Así que los valores que
 * también existen allá (los tipos de vencimiento) están duplicados aquí a mano,
 * igual que `plan-shape.ts` duplica los del onboarding, y
 * `guided-setup-shape.test.ts` compara las dos listas para que no se separen.
 */

// ---------------------------------------------------------------------------
// Lo que se puede crear
// ---------------------------------------------------------------------------

export const SETUP_KINDS = ['commitment', 'routine', 'flow', 'client', 'space'] as const;
export type SetupKind = (typeof SETUP_KINDS)[number];

/**
 * Cómo se le habla de cada cosa a un gerente. Nunca "pipeline", nunca
 * "espacio del cerebro", nunca "umbral": quien está contando cómo despacha
 * carga refrigerada no tiene por qué aprender el organigrama interno del
 * producto para decir que sí o que no.
 */
export const KIND_COPY: Record<
  SetupKind,
  { noun: string; verb: string; where: string; href: string; blurb: string }
> = {
  commitment: {
    noun: 'Fecha vigilada',
    verb: 'Vigilar esta fecha',
    where: 'Vencimientos',
    href: '/commitments',
    blurb: 'Cortex te avisa antes de que se venza, con los días de anticipación que definiste.',
  },
  routine: {
    noun: 'Rutina',
    verb: 'Dejar esto corriendo',
    where: 'Rutinas',
    href: '/schedules',
    blurb: 'Corre sola a la hora que dijiste y te deja el resultado en el chat.',
  },
  flow: {
    noun: 'Flujo',
    verb: 'Guardar este flujo',
    where: 'Flujos',
    href: '/pipelines',
    blurb: 'Los pasos quedan escritos y el flujo se detiene donde una persona tiene que decidir.',
  },
  client: {
    noun: 'Cliente',
    verb: 'Registrar el cliente',
    where: 'Clientes',
    href: '/clients',
    blurb: 'Sus correos, documentos y fechas quedan colgando de un mismo nombre.',
  },
  space: {
    noun: 'Espacio de documentos',
    verb: 'Crear el espacio',
    where: 'Brain Knowledge',
    href: '/kb',
    blurb: 'Un sitio para guardar los papeles de este tema y poder citarlos después.',
  },
};

// ---------------------------------------------------------------------------
// Lo que el producto hace, pero no escribiendo
// ---------------------------------------------------------------------------

export const HANDOFF_KINDS = ['tramite', 'errand', 'source'] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

export const HANDOFF_COPY: Record<
  HandoffKind,
  { title: string; why: string; href: string; cta: string }
> = {
  tramite: {
    title: 'Un trámite en un portal',
    why: 'Esto Cortex lo aprende viéndote hacerlo una vez, no contándoselo. Grabas el trámite en el portal y después lo repite solo.',
    href: '/browser',
    cta: 'Enseñarle el trámite',
  },
  errand: {
    title: 'Un encargo largo',
    why: 'Esto no se configura: se encarga cuando lo necesites y Cortex lo va haciendo por su cuenta, preguntándote sólo lo que no pueda decidir.',
    href: '/errands',
    cta: 'Ver encargos',
  },
  source: {
    title: 'Traer una fuente',
    why: 'El correo, el calendario y los archivos entran conectando la cuenta, que es un permiso que sólo tú puedes dar.',
    href: '/integrations',
    cta: 'Conectar una fuente',
  },
};

// ---------------------------------------------------------------------------
// Los campos que cada módulo exige de verdad
// ---------------------------------------------------------------------------

/**
 * Duplicado de `COMMITMENT_KINDS` en packages/agent-tools/src/commitments/shape.ts.
 * El test compara las dos listas.
 */
export const COMMITMENT_KINDS = [
  'soat',
  'rtm',
  'contract',
  'policy',
  'warranty',
  'customs',
  'payment',
  'internal',
  'other',
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Una fecha sin fuente no existe en Vencimientos, y el módulo lo hace cumplir:
 * `createCommitment` exige un `source` y Postgres lo vuelve a exigir. Desde una
 * entrevista la única fuente honesta es `manual` — lo dijo una persona y esa
 * persona lo va a confirmar en pantalla.
 *
 * La otra mitad de la regla es de este archivo: sin fecha exacta no hay
 * vencimiento. «El SOAT de los camiones vence cada año» no es una fecha, es una
 * política, y proponerla como vencimiento significaría inventar el día. Cuando
 * el modelo devuelve algo así, `normalizeProposal` lo rechaza y la entrevista
 * puede preguntar el día — que es una buena pregunta — en vez de adivinarlo.
 */
const commitmentPayload = z.object({
  title: z.string().trim().min(3).max(200),
  dueOn: z.string().regex(ISO_DATE),
  kind: z.enum(COMMITMENT_KINDS).default('other'),
  noticeDays: z.number().int().min(0).max(365).optional(),
  counterparty: z.string().trim().max(160).optional(),
  detail: z.string().trim().max(1000).optional(),
});

/** Cinco campos, el estándar de cron. `schedule.create` valida el resto. */
const CRON_5 = /^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/;

const routinePayload = z.object({
  name: z.string().trim().min(3).max(120),
  cron: z.string().trim().regex(CRON_5),
  timezone: z.string().trim().min(3).max(64).default('America/Bogota'),
  instruction: z.string().trim().min(10).max(4000),
});

const flowPayload = z.object({
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().max(300).default(''),
  steps: z
    .array(
      z.object({
        title: z.string().trim().min(2).max(80),
        detail: z.string().trim().min(5).max(2000),
        checkpoint: z.boolean().default(false),
      }),
    )
    .min(2)
    .max(12),
});

const clientPayload = z.object({
  name: z.string().trim().min(2).max(160),
  nit: z.string().trim().max(32).optional(),
  city: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(1000).optional(),
});

const spacePayload = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(300).default(''),
});

const PAYLOAD: Record<SetupKind, z.ZodTypeAny> = {
  commitment: commitmentPayload,
  routine: routinePayload,
  flow: flowPayload,
  client: clientPayload,
  space: spacePayload,
};

export type CommitmentPayload = z.infer<typeof commitmentPayload>;
export type RoutinePayload = z.infer<typeof routinePayload>;
export type FlowPayload = z.infer<typeof flowPayload>;
export type ClientPayload = z.infer<typeof clientPayload>;
export type SpacePayload = z.infer<typeof spacePayload>;

export type SetupPayload =
  | CommitmentPayload
  | RoutinePayload
  | FlowPayload
  | ClientPayload
  | SpacePayload;

export interface ProposedItem {
  kind: SetupKind;
  title: string;
  rationale: string;
  payload: SetupPayload;
}

export type ItemStatus = 'proposed' | 'created' | 'merged' | 'skipped' | 'failed' | 'undone';

/** Un ítem tal como lo lee la pantalla, ya con su id de base de datos. */
export interface SetupItem extends ProposedItem {
  id: string;
  status: ItemStatus;
  targetTable: string | null;
  targetId: string | null;
  error: string | null;
}

export interface Handoff {
  kind: HandoffKind;
  /** Lo que la persona quería, con sus palabras. */
  want: string;
}

export interface OutOfScope {
  /** Lo que pidió, literal. Se guarda sin editar: es la lista de lo que falta. */
  want: string;
  /** Por qué no se puede, en una frase, sin prometer que llegará. */
  note: string;
}

// ---------------------------------------------------------------------------
// El filtro
// ---------------------------------------------------------------------------

export type NormalizeResult =
  | { ok: true; item: ProposedItem }
  | {
      ok: false;
      reason: string;
      kind: string;
      title: string;
      /**
       * A dónde va lo rechazado cuando la persona merece una respuesta y no
       * silencio. `handoff` cuando el producto sí lo hace por otro camino;
       * `'scope'` cuando no lo hace y hay que decirlo; `null` cuando lo que
       * falló fue la forma del dato y no la promesa (una fecha que no era una
       * fecha) — eso no se le cuenta a nadie, se pregunta otra vez.
       */
      route: HandoffKind | 'scope' | null;
    };

// ---------------------------------------------------------------------------
// Lo que una rutina creada aquí NO puede prometer
// ---------------------------------------------------------------------------

/**
 * EL FILTRO QUE NO DEPENDE DEL MODELO.
 *
 * Un tipo válido con campos válidos todavía puede ser una mentira. «Todos los
 * lunes a las 7 avísale por WhatsApp al cliente que su contenedor llegó» es una
 * rutina perfectamente formada: nombre, cron, instrucción. Se crearía sin
 * problema, y no haría nada de lo que dice.
 *
 * Y la razón no es una opinión sobre el modelo: es una propiedad de lo que
 * `createRoutineItem` escribe. Una rutina nacida de una entrevista se crea con
 * `allow_unattended_writes: false` — a propósito, porque no es una decisión que
 * se tome por alguien en su primer día a partir de una frase hablada. Una
 * rutina así INFORMA; no manda, no paga, no firma, no radica. Cualquier
 * instrucción que le pida actuar hacia afuera describe algo que la fila creada
 * no puede hacer.
 *
 * Lo mismo con los portales. Una rutina no sabe navegar la DIAN: eso son
 * trámites, y se aprenden grabando el portal una vez. Pedirlo aquí no está mal
 * — está en el sitio equivocado, y la respuesta correcta es llevar a la persona
 * a donde sí se hace.
 *
 * Aplica SÓLO a rutinas, y la excepción es deliberada. Un flujo es un
 * procedimiento escrito que siguen PERSONAS; que uno de sus pasos diga «el
 * auxiliar manda el correo al cliente» es exactamente lo que un flujo debe
 * decir, y no promete nada de parte de Cortex.
 *
 * Falla hacia menos: ante la duda rechaza, y rechazar produce una frase honesta
 * en pantalla en vez de una rutina muda.
 */

/** Sin tildes y en minúscula, para que una sola regla cubra las dos escrituras. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * «Sin pagar», «facturas por pagar»: eso describe un ESTADO, no le pide a nadie
 * que pague. Se quitan antes de buscar verbos, porque «dime qué facturas siguen
 * sin pagar» es exactamente lo que una rutina sí sabe hacer y sería absurdo
 * rechazarlo por contener la palabra.
 */
const STATE_PHRASE =
  /\b(sin|por)\s+(pagar|facturar|firmar|radicar|enviar|mandar|responder|contestar|llamar|publicar|transferir|cobrar)\b/g;

/**
 * Actuar hacia afuera. Las formas con pronombre en primera persona —«envíame»,
 * «mándame»— no están y no pueden estar: `\benvia\b` no casa dentro de
 * «enviame», que es justamente lo que una rutina sí hace (avisarte a ti).
 */
const OUTWARD =
  /\b(envia|enviar|envie|envien|manda|mandar|mande|manden|responde|responder|responda|contesta|contestar|conteste|pagar|pague|paguen|transferir|transfiera|facturar|facture|firmar|firme|radicar|radique|llamar|llame|publicar|publique|cobrar|cobre)\b/;

/**
 * Y las mismas hacia una tercera persona: «avísale», «llámalo», «págale». El
 * pronombre pegado es lo que las separa de «avísame», y es toda la diferencia
 * entre informar y actuar.
 */
const OUTWARD_CLITIC =
  /\b(avisa|escribe|contacta|llama|paga|pague|responde|contesta|manda|envia|factura|cobra|firma|radica)(le|les|lo|la|los|las|selo|sela)\b/;

/** Sitios donde hay que entrar con usuario y contraseña: eso son trámites. */
const PORTAL =
  /\b(dian|runt|simit|vuce|muisca|siat|sicex|supersociedades|camara de comercio|portal|plataforma|pagina web|sitio web|banco|bancolombia|davivienda|naviera|aerolinea)\b/;

/** Saber dónde va algo ahora mismo. Cortex no lee sensores. */
const LIVE = /\b(gps|tiempo real|rastreo|rastrear|en vivo|geocerca|telemetria)\b/;

export interface CapabilityRefusal {
  reason: string;
  route: HandoffKind | 'scope';
}

/**
 * ¿Esta rutina promete algo que la fila creada no puede cumplir? Pura, sin
 * modelo, sin red — y por eso comprobable con un test normal.
 */
export function capabilityRefusal(
  kind: SetupKind,
  payload: SetupPayload,
): CapabilityRefusal | null {
  if (kind !== 'routine') return null;
  const text = fold(`${(payload as RoutinePayload).instruction ?? ''}`).replace(STATE_PHRASE, ' ');

  if (PORTAL.test(text)) {
    return {
      reason:
        'Una rutina no sabe entrar a un portal con usuario y contraseña. Eso son trámites y se enseñan grabándolos una vez.',
      route: 'tramite',
    };
  }
  if (OUTWARD.test(text) || OUTWARD_CLITIC.test(text)) {
    return {
      reason:
        'Una rutina creada aquí no manda, no paga ni firma nada por su cuenta: nace sin ese permiso, sólo te informa a ti. Si de verdad la quieres así, hay que dársela a mano.',
      route: 'scope',
    };
  }
  if (LIVE.test(text)) {
    return {
      reason: 'Cortex no lee posiciones ni sensores en vivo, así que no puede vigilar eso.',
      route: 'scope',
    };
  }
  return null;
}

/** Máximo por sesión. Más que esto no es una puesta en marcha, es un vertedero. */
export const MAX_ITEMS = 8;

/** Cuánto puede estar en el pasado una fecha para seguir mereciendo vigilancia. */
const PAST_DAYS = 45;
/** Y cuánto en el futuro antes de que deje de ser una fecha y sea una suposición. */
const FUTURE_DAYS = 3650;

function daysFromToday(iso: string, today: string): number | null {
  const a = Date.parse(`${iso}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

/**
 * Convierte lo que devolvió el modelo en algo que se puede crear, o lo rechaza.
 *
 * Se ejecuta en el servidor sobre la respuesta del modelo, y otra vez en el
 * servidor antes de crear nada. Dos veces a propósito: la primera decide qué se
 * le muestra a la persona, la segunda decide qué se escribe. Entre las dos hay
 * una petición HTTP, y todo lo que atraviesa una petición HTTP es entrada.
 */
export function normalizeProposal(raw: unknown, today: string): NormalizeResult {
  const outer = z
    .object({
      kind: z.string(),
      title: z.string().trim().min(1).max(200),
      rationale: z.string().trim().max(600).default(''),
      payload: z.unknown(),
    })
    .safeParse(raw);

  if (!outer.success) {
    return {
      ok: false,
      reason: 'La propuesta llegó incompleta.',
      kind: '?',
      title: '?',
      route: null,
    };
  }
  const { kind, title, rationale } = outer.data;

  if (!(SETUP_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      reason: `«${kind}» no es algo que este producto sepa crear.`,
      kind,
      title,
      // Un tipo inventado sí se le cuenta a la persona: pidió algo real.
      route: (HANDOFF_KINDS as readonly string[]).includes(kind) ? (kind as HandoffKind) : 'scope',
    };
  }
  const setupKind = kind as SetupKind;

  const parsed = PAYLOAD[setupKind].safeParse(outer.data.payload);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    const where = first?.path.join('.') || 'los datos';
    return {
      ok: false,
      reason: `Faltan datos para crearlo: ${where}.`,
      kind,
      title,
      route: null,
    };
  }

  if (setupKind === 'commitment') {
    const payload = parsed.data as CommitmentPayload;
    const delta = daysFromToday(payload.dueOn, today);
    if (delta === null) {
      return { ok: false, reason: 'Esa fecha no es una fecha.', kind, title, route: null };
    }
    if (delta < -PAST_DAYS || delta > FUTURE_DAYS) {
      return {
        ok: false,
        reason: 'Esa fecha está demasiado lejos para vigilarla; hay que confirmarla primero.',
        kind,
        title,
        route: null,
      };
    }
  }

  // La última puerta, y la que no depende de que el modelo se porte bien: una
  // propuesta con la forma correcta que promete algo que la fila creada no
  // puede cumplir.
  const refusal = capabilityRefusal(setupKind, parsed.data as SetupPayload);
  if (refusal) {
    return { ok: false, reason: refusal.reason, kind, title, route: refusal.route };
  }

  return {
    ok: true,
    item: { kind: setupKind, title, rationale, payload: parsed.data as SetupPayload },
  };
}

/** `slug` de un flujo, derivado del nombre. `pipeline.create` exige este formato. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base.length >= 2 ? base : `flujo-${Date.now().toString(36).slice(-6)}`;
}

// ---------------------------------------------------------------------------
// Cuándo callarse
// ---------------------------------------------------------------------------

/**
 * CUÁNTAS PREGUNTAS, Y CÓMO SE DECIDE PARAR
 *
 * Cinco, como techo duro, y casi siempre menos. El número no sale de un
 * cuestionario: sale de que cada pregunta tiene que DESBLOQUEAR una propuesta
 * concreta que sin ella no se puede hacer. Si alguien cuenta que despacha carga
 * refrigerada, la siguiente pregunta es por la cadena de frío — no la número 7
 * de una lista — y si esa respuesta ya permite proponer, no hay una octava.
 *
 * Se para por cuatro razones distintas y las cuatro son buenas:
 *
 *   enough    El modelo dice que ya puede proponer. Es la salida normal y la
 *             más frecuente; el prompt le exige parar en cuanto tenga con qué.
 *   cap       Se llegó a cinco. Existe porque un modelo que no sabe parar
 *             convierte esto en un interrogatorio, y porque el tope tiene que
 *             ser del servidor: un límite que lleva el cliente es un límite que
 *             el cliente puede subir.
 *   thin      Las dos últimas respuestas fueron de una palabra o un «no». La
 *             persona ya se cansó. Seguir preguntando no va a mejorar el plan,
 *             sólo va a empeorar la impresión.
 *   asked     Lo pidió: hay un botón para saltarse el resto y ver el plan.
 *
 * Y un piso, no sólo un techo: si lo único que se dijo fueron dos frases, hay
 * que preguntar al menos una vez. Proponer sobre 40 caracteres es adivinar.
 */
export const MAX_QUESTIONS = 5;
export const MIN_OPENING_CHARS = 80;

export type StopReason = 'enough' | 'cap' | 'thin' | 'asked';

export const STOP_COPY: Record<StopReason, string> = {
  enough: 'Con esto me alcanza.',
  cap: 'No te pregunto más.',
  thin: 'Listo, no te enredo más.',
  asked: 'Va, te muestro lo que tengo.',
};

/** Una respuesta que no aporta: muy corta, o una negativa seca. */
export function isThinAnswer(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return true;
  if (/^(no|nada|ya|listo|ninguno|ninguna|nel|n\/a|no s[eé]|nose)\b[.!\s]*$/i.test(t)) return true;
  return t.length < 12;
}

export interface StopInput {
  /** Cuántas preguntas se han hecho ya en esta sesión. */
  askedCount: number;
  /** Lo que el modelo dijo en este turno. */
  modelSaysEnough: boolean;
  /** Las respuestas de la persona, en orden. La primera es lo que contó. */
  answers: readonly string[];
  /** La persona tocó «muéstrame ya lo que tienes». */
  forced?: boolean;
}

export function decideStop(input: StopInput): StopReason | null {
  const { askedCount, modelSaysEnough, answers, forced } = input;

  // El piso. Ni el modelo ni el botón pueden saltárselo: con dos frases no hay
  // nada que proponer que no sea inventado.
  const opening = (answers[0] ?? '').trim();
  if (askedCount === 0 && opening.length < MIN_OPENING_CHARS) return null;

  if (forced) return 'asked';
  if (askedCount >= MAX_QUESTIONS) return 'cap';
  if (modelSaysEnough) return 'enough';

  // Dos respuestas flacas seguidas. Sólo cuenta después de que se haya
  // preguntado dos veces: la apertura no es una respuesta a nada.
  if (askedCount >= 2) {
    const last = answers.slice(-2);
    if (last.length === 2 && last.every(isThinAnswer)) return 'thin';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cómo se muestra un ítem antes de existir
// ---------------------------------------------------------------------------

export interface Field {
  label: string;
  value: string;
}

const DOW = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/**
 * Un cron dicho en español. Cubre los casos que la entrevista genera de verdad
 * — todos los días, ciertos días, día del mes — y si no lo entiende, muestra el
 * cron crudo en vez de inventarse una frase bonita que no corresponda.
 */
export function cronPhrase(cron: string): string {
  const [min, hour, dom, , dow] = cron.trim().split(/\s+/);
  if (!min || !hour || !/^\d+$/.test(min) || !/^\d+$/.test(hour)) return cron;
  const at = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;

  if (dow && dow !== '*') {
    const days = dow
      .split(',')
      .map((d) => DOW[Number(d) % 7])
      .filter(Boolean);
    if (days.length === 5 && dow.replace(/\s/g, '') === '1,2,3,4,5') {
      return `de lunes a viernes a las ${at}`;
    }
    if (days.length > 0) return `los ${days.join(', ')} a las ${at}`;
  }
  if (dom && dom !== '*' && /^\d+$/.test(dom)) return `el ${dom} de cada mes a las ${at}`;
  return `todos los días a las ${at}`;
}

/** Los datos exactos con los que se va a crear. Sin esto no hay confirmación. */
export function itemFields(item: ProposedItem): Field[] {
  switch (item.kind) {
    case 'commitment': {
      const p = item.payload as CommitmentPayload;
      const fields: Field[] = [{ label: 'Se vence', value: p.dueOn }];
      if (p.noticeDays !== undefined) {
        fields.push({ label: 'Te aviso', value: `${p.noticeDays} días antes` });
      }
      if (p.counterparty) fields.push({ label: 'Con', value: p.counterparty });
      if (p.detail) fields.push({ label: 'Nota', value: p.detail });
      return fields;
    }
    case 'routine': {
      const p = item.payload as RoutinePayload;
      return [
        { label: 'Corre', value: cronPhrase(p.cron) },
        { label: 'Hace', value: p.instruction },
      ];
    }
    case 'flow': {
      const p = item.payload as FlowPayload;
      return p.steps.map((s, i) => ({
        label: `Paso ${i + 1}${s.checkpoint ? ' · para aquí' : ''}`,
        value: `${s.title}. ${s.detail}`,
      }));
    }
    case 'client': {
      const p = item.payload as ClientPayload;
      const fields: Field[] = [];
      if (p.nit) fields.push({ label: 'NIT', value: p.nit });
      if (p.city) fields.push({ label: 'Ciudad', value: p.city });
      if (p.notes) fields.push({ label: 'Nota', value: p.notes });
      return fields;
    }
    case 'space': {
      const p = item.payload as SpacePayload;
      return p.description ? [{ label: 'Para', value: p.description }] : [];
    }
  }
}

/**
 * Se puede deshacer, y por qué no cuando no.
 *
 * `merged` es el único caso que no: la entrevista propuso un cliente que ya
 * existía y el módulo actualizó el que había en vez de crear uno nuevo.
 * Borrarlo destruiría datos que no eran nuestros, así que la respuesta honesta
 * es decir qué pasó y dejar el cliente donde está.
 */
export function undoability(item: SetupItem): { can: boolean; note: string } {
  if (item.status === 'merged') {
    return {
      can: false,
      note: 'Este cliente ya existía y se completó con lo que contaste. No lo borro: los datos que había son tuyos.',
    };
  }
  if (item.status !== 'created') return { can: false, note: '' };
  return { can: true, note: '' };
}
