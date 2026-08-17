import 'server-only';

import {
  COMMITMENT_KINDS,
  HANDOFF_KINDS,
  type Handoff,
  MAX_ITEMS,
  MAX_QUESTIONS,
  type OutOfScope,
  type ProposedItem,
  SETUP_KINDS,
  type SetupKind,
  normalizeProposal,
} from '@/lib/guided-setup-shape';
import { NO_THINKING, chatModel, repairStructured } from '@cortex/agent-tools';
import { generateObject } from 'ai';
import { z } from 'zod';
import type { Turn } from './store';

/**
 * LA ENTREVISTA: QUÉ SE LE PREGUNTA AL MODELO Y QUÉ NO SE LE DEJA DECIDIR.
 *
 * ===========================================================================
 * DOS LLAMADAS DISTINTAS, PORQUE SON DOS TRABAJOS DISTINTOS
 * ===========================================================================
 * `askNext` decide si falta algo y qué. `propose` traduce todo lo dicho a
 * objetos. Juntarlas en una sola llamada — «devuélveme la siguiente pregunta y
 * de paso el plan» — es la forma más rápida de que el modelo empiece a proponer
 * en el turno dos con la mitad de la información, porque el formato se lo
 * permite. Separadas, el turno de preguntar no tiene dónde escribir un plan.
 *
 * ===========================================================================
 * LAS PREGUNTAS SALEN DE LO QUE DIJO, NO DE UNA LISTA
 * ===========================================================================
 * La regla que hace o rompe esto no es cuántas preguntas, es de dónde salen. Un
 * cuestionario fijo pregunta lo mismo a una empresa de carga refrigerada que a
 * una agencia de aduanas, y las dos notan en la segunda pregunta que están
 * llenando un formulario disfrazado. Si alguien cuenta que despacha carga
 * refrigerada, la siguiente pregunta es por la cadena de frío.
 *
 * Por eso el prompt no lleva temario. Lleva una obligación: cada pregunta tiene
 * que nombrar algo que la persona ya dijo, y tiene que desbloquear UNA cosa
 * concreta del catálogo que sin esa respuesta no se puede proponer. Si no hay
 * ninguna pregunta así, ya se puede proponer, y entonces hay que callarse.
 *
 * El tope de cinco existe igual, en el servidor, porque una obligación en un
 * prompt es una petición.
 *
 * ===========================================================================
 * EL MODELO NO ELIGE EL CATÁLOGO
 * ===========================================================================
 * El esquema sólo admite los cinco tipos creables, y después de eso todo pasa
 * por `normalizeProposal`. Un modelo que se invente «alertas por WhatsApp
 * cuando cambie el estado en el puerto» no produce una propuesta rota: no
 * produce ninguna propuesta, y lo que la persona pidió sale en la lista de lo
 * que este producto todavía no hace.
 */

/**
 * Un ítem llega plano y no como unión discriminada a propósito. Un `anyOf` de
 * cinco formas distintas dentro del esquema de una herramienta es donde los
 * modelos empiezan a devolver mezclas — el `payload` de una rutina con el
 * `dueOn` de un vencimiento. Plano y opcional, el modelo sólo tiene que llenar
 * lo que aplica, y `toPayload` recoge lo que corresponde al tipo que declaró.
 * Lo que sobre se ignora; lo que falte lo rechaza el catálogo.
 */
const ItemSchema = z.object({
  kind: z.enum(SETUP_KINDS),
  title: z
    .string()
    .describe('Cómo lo llamaría la persona. Es también el nombre de lo que se crea.'),
  rationale: z.string().describe('Por qué, citando lo que la persona dijo. Una o dos frases.'),

  dueOn: z.string().optional().describe('Vencimiento: la fecha exacta, YYYY-MM-DD.'),
  commitmentKind: z.enum(COMMITMENT_KINDS).optional(),
  noticeDays: z.number().int().optional().describe('Vencimiento: días de aviso previo.'),
  counterparty: z.string().optional(),
  detail: z.string().optional(),

  cron: z.string().optional().describe('Rutina: cron de 5 campos, hora de Bogotá.'),
  instruction: z.string().optional().describe('Rutina: qué debe hacer, en español, en imperativo.'),

  description: z.string().optional().describe('Flujo o espacio: para qué es.'),
  steps: z
    .array(
      z.object({
        title: z.string(),
        detail: z.string(),
        checkpoint: z
          .boolean()
          .describe('true si aquí una persona tiene que decidir antes de seguir.'),
      }),
    )
    .optional()
    .describe('Flujo: entre 2 y 12 pasos.'),

  nit: z.string().optional(),
  city: z.string().optional(),
  notes: z.string().optional(),
});

type RawItem = z.infer<typeof ItemSchema>;

const AskSchema = z.object({
  note: z
    .string()
    .describe('Una frase que muestra que entendiste lo que acaba de decir. Sin adular.'),
  enough: z.boolean().describe('true si ya puedes proponer algo útil sin preguntar más.'),
  question: z.string().optional().describe('La siguiente pregunta, una sola.'),
  unlocks: z
    .string()
    .optional()
    .describe('Qué cosa concreta del catálogo desbloquea esa pregunta.'),
});

const ProposeSchema = z.object({
  summary: z.string().describe('Lo que entendiste de la empresa, en dos o tres frases.'),
  items: z.array(ItemSchema).max(MAX_ITEMS),
  handoffs: z
    .array(z.object({ kind: z.enum(HANDOFF_KINDS), want: z.string() }))
    .max(4)
    .describe('Lo que el producto hace pero no se configura escribiendo.'),
  outOfScope: z
    .array(z.object({ want: z.string(), note: z.string() }))
    .max(4)
    .describe('Lo que pidió y este producto no hace. Sin prometer nada.'),
});

export interface InterviewContext {
  companyName: string;
  today: string;
  /** Si es falso, no se le ofrecen espacios: sólo un administrador los crea. */
  canCreateGlobalSpace: boolean;
}

const CATALOG = [
  'LO QUE PUEDES CREAR. Nada más que esto:',
  '',
  '1. commitment — una fecha vigilada. Cortex avisa antes de que se venza.',
  '   Exige una FECHA EXACTA (dueOn, YYYY-MM-DD). Sin fecha no hay vencimiento:',
  '   «el SOAT vence cada año» no es una fecha, es una política, y si te falta',
  '   el día, pregúntalo — no lo inventes ni lo aproximes.',
  '   commitmentKind: soat, rtm, contract, policy, warranty, customs, payment, other.',
  '',
  '2. routine — algo que corre solo a una hora. cron de 5 campos e instruction',
  '   en español. Sirve para revisiones periódicas y resúmenes. NO puede firmar,',
  '   pagar, ni mandar nada afuera por su cuenta: nace sin permiso de escritura.',
  '',
  '3. flow — un procedimiento de varios pasos que la gente sigue, con paradas',
  '   donde una persona decide (checkpoint). Entre 2 y 12 pasos. Es la respuesta',
  '   correcta cuando lo que te contaron es «cuando pasa X hacemos A, B y C».',
  '',
  '4. client — un cliente con nombre, y si lo dijeron, NIT y ciudad.',
  '',
  '5. space — un sitio de la empresa para guardar documentos de un tema y poder',
  '   citarlos después.',
  '',
  'LO QUE EL PRODUCTO HACE PERO NO SE CONFIGURA HABLANDO (van en handoffs, no',
  'en items, y no se crea nada):',
  '  tramite — un trámite en un portal (DIAN, RUNT, bancos, navieras). Cortex lo',
  '            aprende viendo a alguien hacerlo una vez, no contándoselo.',
  '  errand  — un encargo largo. Se encarga cuando haga falta, no se configura.',
  '  source  — traer el correo, el calendario o los archivos. Es conectar una',
  '            cuenta, y sólo la persona puede autorizarla.',
  '',
  'TODO LO DEMÁS va en outOfScope, con las palabras de la persona y una razón',
  'corta. Ejemplos de lo que NO existe: integrarse con un ERP a la medida,',
  'facturar, mover plata, chatear con los clientes finales, rastrear GPS en vivo,',
  'leer un portal en tiempo real. Si te piden algo así, dilo: «eso todavía no lo',
  'puedo hacer solo». No inventes una rutina ni un flujo que aparente resolverlo.',
].join('\n');

function voice(ctx: InterviewContext): string {
  return [
    `Eres Cortex hablando con alguien de ${ctx.companyName} el día ${ctx.today}.`,
    'Es un gerente o un jefe de operaciones, no un implantador: sabe perfectamente',
    'cómo funciona su empresa y no tiene por qué saber cómo funciona la tuya.',
    'Nunca uses las palabras "espacio del cerebro", "pipeline", "umbral",',
    '"integración", "flujo de trabajo automatizado" ni nada que suene a manual.',
    'Español de Colombia, tuteo, frases cortas, cero relleno y cero adulación.',
    'La zona horaria es America/Bogota.',
  ].join('\n');
}

function transcriptText(turns: readonly Turn[]): string {
  return turns
    .map((t) => `${t.role === 'person' ? 'PERSONA' : 'CORTEX'}: ${t.text}`)
    .join('\n\n')
    .slice(-12_000);
}

export interface AskResult {
  note: string;
  enough: boolean;
  question: string | null;
}

/** El turno de preguntar. Nunca puede devolver un plan: el esquema no lo tiene. */
export async function askNext(
  turns: readonly Turn[],
  askedCount: number,
  ctx: InterviewContext,
): Promise<AskResult> {
  const left = Math.max(0, MAX_QUESTIONS - askedCount);
  const system = [
    voice(ctx),
    '',
    'Estás entendiendo cómo trabaja esta empresa para configurarle Cortex.',
    'No estás resolviendo su problema todavía: estás decidiendo si te falta algo.',
    '',
    CATALOG,
    '',
    'CÓMO PREGUNTAS:',
    `- Te quedan ${left} preguntas como máximo en toda la conversación. Úsalas mal y`,
    '  esto se vuelve un interrogatorio, que es la razón por la que nadie termina',
    '  estas cosas.',
    '- Una sola pregunta por turno.',
    '- La pregunta tiene que nombrar algo que la persona YA dijo, con sus palabras.',
    '- Y tiene que desbloquear una cosa concreta del catálogo que sin esa respuesta',
    '  no puedes proponer. Dilo en `unlocks`. Si no se te ocurre qué desbloquea,',
    '  entonces no hace falta: pon enough en true.',
    '- Prohibido preguntar por cortesía, por contexto general, o "para conocerlos',
    '  mejor". Prohibido preguntar algo que ya te contestaron.',
    '- Si lo que falta es una FECHA para un vencimiento que ya se mencionó, esa es',
    '  casi siempre la mejor pregunta que puedes hacer.',
    '',
    'PARA EN CUANTO PUEDAS. Si con lo que ya sabes puedes proponer dos o tres cosas',
    'útiles, pon enough en true aunque te queden preguntas. Sobra información nunca;',
    'sobra paciencia siempre.',
  ].join('\n');

  const { object } = await generateObject({
    model: chatModel(),
    schema: AskSchema,
    // Ver structured.ts: el envoltorio llega mal, el contenido bien.
    experimental_repairText: repairStructured(['note', 'enough', 'question', 'unlocks']),
    system,
    prompt: `LA CONVERSACIÓN HASTA AHORA\n\n${transcriptText(turns)}\n\n¿Te falta algo?`,
    experimental_providerMetadata: NO_THINKING,
    maxTokens: 900,
  });

  const question = (object.question ?? '').trim();
  return {
    note: object.note.trim().slice(0, 240),
    // Un turno que dice "me falta algo" y no trae pregunta es un turno que ya
    // terminó, lo diga o no.
    enough: object.enough || question.length === 0,
    question: question || null,
  };
}

export interface Proposal {
  summary: string;
  items: ProposedItem[];
  handoffs: Handoff[];
  outOfScope: OutOfScope[];
  /** Lo que el modelo propuso y el catálogo rechazó. Se registra, no se muestra. */
  rejected: { kind: string; title: string; reason: string }[];
}

/** El turno de proponer. Todo lo que salga de aquí pasa por el catálogo. */
export async function propose(turns: readonly Turn[], ctx: InterviewContext): Promise<Proposal> {
  const system = [
    voice(ctx),
    '',
    'Ya escuchaste lo suficiente. Ahora traduces lo que te contaron a cosas',
    'configuradas dentro de Cortex. Alguien va a mirar tu lista y a decir sí o no,',
    'ítem por ítem, así que cada cosa tiene que justificarse sola.',
    '',
    CATALOG,
    '',
    'REGLAS DE LA PROPUESTA:',
    `- Como mucho ${MAX_ITEMS} cosas, y menos es mejor. Tres cosas que se van a usar`,
    '  valen más que ocho plausibles: lo que nadie pidió alguien lo tiene que borrar.',
    '- Cada ítem tiene que salir de algo que dijeron. En `rationale`, cítalo.',
    '- No propongas nada "por si acaso", ni lo típico del sector, ni lo que crees',
    '  que toda empresa necesita. Si no lo dijeron, no va.',
    '- Un vencimiento sin fecha exacta NO se propone. Ni con una fecha aproximada,',
    '  ni con la de "dentro de un año". Si falta el día, no propongas el ítem.',
    '- Los títulos son los que usaría la persona, no los tuyos.',
    ctx.canCreateGlobalSpace
      ? '- Puedes proponer un espacio de documentos si hay un tema con papeles claros.'
      : '- NO propongas espacios de documentos: esta persona no puede crearlos.',
    '',
    'Y lo más importante: si te pidieron algo que no está en el catálogo, ponlo en',
    'outOfScope con sus palabras y di que todavía no se puede. No lo maquilles',
    'como una rutina o un flujo que "más o menos" lo hace. Preferimos quedarnos',
    'cortos hoy que quedar mal la semana entrante.',
  ].join('\n');

  const { object } = await generateObject({
    model: chatModel(),
    schema: ProposeSchema,
    // Ver structured.ts: el envoltorio llega mal, el contenido bien.
    experimental_repairText: repairStructured(['summary', 'items', 'handoffs', 'outOfScope']),
    system,
    prompt: `LA CONVERSACIÓN COMPLETA\n\n${transcriptText(turns)}\n\nArma la propuesta.`,
    experimental_providerMetadata: NO_THINKING,
    maxTokens: 4096,
  });

  const items: ProposedItem[] = [];
  const rejected: Proposal['rejected'] = [];
  const handoffs: Handoff[] = object.handoffs.map((h) => ({
    kind: h.kind,
    want: h.want.trim().slice(0, 240),
  }));
  const outOfScope: OutOfScope[] = object.outOfScope.map((o) => ({
    want: o.want.trim().slice(0, 300),
    note: o.note.trim().slice(0, 300),
  }));

  for (const raw of object.items) {
    if (raw.kind === 'space' && !ctx.canCreateGlobalSpace) {
      rejected.push({
        kind: raw.kind,
        title: raw.title,
        reason: 'Sólo un administrador puede crear un espacio de la empresa.',
      });
      continue;
    }
    const result = normalizeProposal(
      {
        kind: raw.kind,
        title: raw.title,
        rationale: raw.rationale,
        payload: toPayload(raw.kind, raw),
      },
      ctx.today,
    );
    if (result.ok) {
      items.push(result.item);
      continue;
    }
    rejected.push({ kind: result.kind, title: result.title, reason: result.reason });

    // Un rechazo con destino NO se traga: la persona pidió algo real y merece
    // saber qué pasó con eso. Si el modelo lo empaquetó como una rutina que
    // manda correos, el código lo desarma y lo pone donde de verdad va — que es
    // la diferencia entre «no salió» y «no te lo puedo hacer, y te digo dónde
    // sí». Los rechazos de FORMA (`route: null`) sí se callan: «faltó la fecha»
    // no es una limitación del producto, es una pregunta pendiente.
    if (result.route === 'scope') {
      outOfScope.push({ want: result.title, note: result.reason });
    } else if (result.route) {
      handoffs.push({ kind: result.route, want: result.title });
    }
  }

  return {
    summary: object.summary.trim().slice(0, 600),
    items: items.slice(0, MAX_ITEMS),
    handoffs: dedupe(handoffs, (h) => `${h.kind}|${h.want}`).slice(0, 6),
    outOfScope: dedupe(outOfScope, (o) => o.want).slice(0, 6),
    rejected,
  };
}

function dedupe<T>(list: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((item) => {
    const k = key(item).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Recoge del ítem plano sólo lo que su tipo usa. Lo demás se cae. */
function toPayload(kind: SetupKind, raw: RawItem): Record<string, unknown> {
  switch (kind) {
    case 'commitment':
      return {
        title: raw.title,
        dueOn: raw.dueOn,
        kind: raw.commitmentKind ?? 'other',
        noticeDays: raw.noticeDays,
        counterparty: raw.counterparty,
        detail: raw.detail,
      };
    case 'routine':
      return {
        name: raw.title,
        cron: raw.cron,
        timezone: 'America/Bogota',
        instruction: raw.instruction,
      };
    case 'flow':
      return {
        name: raw.title,
        description: raw.description ?? '',
        steps: raw.steps,
      };
    case 'client':
      return { name: raw.title, nit: raw.nit, city: raw.city, notes: raw.notes };
    case 'space':
      return { name: raw.title, description: raw.description ?? '' };
  }
}
