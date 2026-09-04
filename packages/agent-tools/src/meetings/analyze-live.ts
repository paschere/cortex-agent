import { generateObject } from 'ai';
import { z } from 'zod';
import { utilityModel } from '../model';
import { repairStructured } from '../structured';
import type { LiveLine, LivePerson } from './archive-live';
import { type CallEvent, formatTimelineForPrompt } from './timeline';

/**
 * Lo que Cortex saca de una llamada cuando cuelga.
 *
 * Una lectura, una vez, al terminar: título que diga de qué fue, resumen en
 * tres líneas, decisiones, compromisos con dueño y fecha, próximos pasos, y
 * un veredicto — ¿vale la pena que esta llamada quede en la memoria de la
 * empresa? El veredicto se ejecuta (archive-live la guarda o no en Brain
 * Knowledge) y se muestra con su razón, para que la persona pueda darle la
 * vuelta con un clic.
 *
 * Sin thinking: es un resumen, no una deliberación; lo que importa es que
 * salga rápido después de colgar.
 */

export const CommitmentSchema = z.object({
  who: z.string().describe('Quién se comprometió, por nombre como aparece en la llamada.'),
  what: z.string().describe('Qué va a hacer, en una frase.'),
  when: z
    .string()
    .nullable()
    .describe('Para cuándo, tal como lo dijeron («el viernes», «antes de fin de mes»), o null.'),
});

export const InsightsSchema = z.object({
  title: z
    .string()
    .max(90)
    .describe('Título corto de la reunión, de qué fue. Sin fecha ni código del Meet.'),
  summary: z.string().max(700).describe('Resumen en 2-4 frases, en español, para quien no estuvo.'),
  highlights: z.array(z.string().max(200)).max(6).describe('Lo más importante que se dijo.'),
  decisions: z.array(z.string().max(200)).max(8).describe('Decisiones que quedaron tomadas.'),
  commitments: z.array(CommitmentSchema).max(10),
  nextSteps: z
    .array(z.string().max(200))
    .max(8)
    .describe('Qué sigue, aunque nadie lo haya asumido.'),
  openQuestions: z.array(z.string().max(200)).max(6).describe('Lo que quedó sin resolver.'),
  worthKeeping: z
    .boolean()
    .describe(
      'true si la llamada tiene contenido que la empresa querrá volver a consultar: decisiones, acuerdos, cifras, compromisos, contexto de un cliente o proyecto. false si fue una prueba de audio, una charla sin sustancia, o casi no se habló.',
    ),
  reason: z
    .string()
    .max(240)
    .describe(
      'Por qué sí o por qué no vale la pena guardarla, en una frase dirigida a la persona.',
    ),
});

export type LiveInsights = z.infer<typeof InsightsSchema>;

const KEYS = [
  'title',
  'summary',
  'highlights',
  'decisions',
  'commitments',
  'nextSteps',
  'openQuestions',
  'worthKeeping',
  'reason',
] as const;

/** Debajo de esto no hay nada que analizar: ni gastamos el modelo. */
const MIN_WORDS = 40;

function clock(ms: number, startedAt: number): string {
  const sec = Math.max(0, Math.floor((ms - startedAt) / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function tooShortToAnalyze(lines: LiveLine[]): boolean {
  const words = lines.reduce((n, l) => n + l.text.trim().split(/\s+/).filter(Boolean).length, 0);
  return words < MIN_WORDS;
}

export function emptyInsights(reason: string): LiveInsights {
  return {
    title: '',
    summary: '',
    highlights: [],
    decisions: [],
    commitments: [],
    nextSteps: [],
    openQuestions: [],
    worthKeeping: false,
    reason,
  };
}

export async function analyzeLiveCall(input: {
  lines: LiveLine[];
  participants: LivePerson[];
  startedAt: number;
  endedAt: number;
  botName?: string | null;
  timeline?: CallEvent[];
}): Promise<LiveInsights> {
  if (tooShortToAnalyze(input.lines)) {
    return emptyInsights('Casi no se habló: no hay nada que valga la pena recordar.');
  }

  const names = input.participants
    .filter((p) => !p.self)
    .map((p) => p.name)
    .filter(Boolean);
  const minutes = Math.max(1, Math.round((input.endedAt - input.startedAt) / 60_000));

  // Ventana: las últimas ~12k palabras bastan para una lectura; una llamada
  // de dos horas no cabe entera y lo importante suele estar repartido, así
  // que se muestrea de forma pareja en vez de cortar el principio.
  const MAX_LINES = 900;
  const lines =
    input.lines.length <= MAX_LINES
      ? input.lines
      : input.lines.filter((_, i) => i % Math.ceil(input.lines.length / MAX_LINES) === 0);

  const transcript = lines
    .map((l) => `[${clock(l.at, input.startedAt)}] ${l.speaker ?? 'Alguien'}: ${l.text.trim()}`)
    .join('\n');

  const system = [
    'Eres Cortex, el agente del espacio de trabajo. Acabas de estar en una reunión de Google Meet escuchando y ahora la resumes para el equipo.',
    'Escribe en español neutro, concreto, con nombres y cifras tal como se dijeron. No inventes: si algo no se dijo, no está.',
    'Los hablantes vienen del mosaico de Meet y pueden estar mal atribuidos; si dudas de quién dijo algo, no lo atribuyas.',
    'Si hay una línea de tiempo visual, úsala: quién compartió pantalla y qué se vio cuenta como parte de la reunión.',
    `Tu propio nombre en la llamada era «${input.botName ?? 'Cortex'}»: lo que dijiste tú no es un compromiso de nadie.`,
    'Decide con criterio si la llamada merece quedar en la memoria de la empresa (Brain Knowledge): sí cuando hay decisiones, acuerdos, cifras, compromisos o contexto de un cliente, proveedor o proyecto; no cuando fue una prueba, una charla social, o no se dijo nada que alguien vaya a querer buscar después.',
  ].join('\n');

  const prompt = [
    `REUNIÓN · ${minutes} min · ${names.length ? `con ${names.join(', ')}` : 'participantes sin nombre'}`,
    '',
    input.timeline?.length
      ? `LO QUE PASÓ EN PANTALLA\n${formatTimelineForPrompt(input.timeline)}`
      : null,
    'TRANSCRIPT',
    transcript,
    '',
    'Devuelve la lectura de la reunión.',
  ]
    .filter((line) => line !== null)
    .join('\n');

  const { object } = await generateObject({
    model: utilityModel(),
    schema: InsightsSchema,
    // Ver structured.ts: el envoltorio llega mal, el contenido bien.
    experimental_repairText: repairStructured(KEYS),
    system,
    prompt,
    maxTokens: 2500,
  });

  return {
    ...object,
    title: object.title.trim(),
    summary: object.summary.trim(),
    reason: object.reason.trim(),
  };
}
