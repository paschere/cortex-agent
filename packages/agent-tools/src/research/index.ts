import { IntegrationError, ValidationError } from '@cortex/core';
import { z } from 'zod';
import { writeAuditEvent } from '../audit';
import { researchModel } from '../model';
import { listTools, registerTool } from '../registry';
import type { ToolContext } from '../types';
import { researchToolsFrom } from './allowlist';
import {
  type ItemOutcome,
  type ResearchItem,
  type ResearchResult,
  type StopReason,
  buildResult,
} from './merge';
import { type GenerateFn, defaultGenerate, runItem } from './runner';
import { runPool } from './scheduler';

export { RESEARCH_READ_TOOLS, isResearchAllowed, researchRejection } from './allowlist';
export { runPool } from './scheduler';

/**
 * research.parallel — INVESTIGACIÓN EN PARALELO (como «Wide Research» de Manus).
 *
 * Para tareas de AMPLITUD: la misma pregunta sobre muchos elementos
 * («compara 30 proveedores», «revisa estas 200 facturas», «resume cada contrato
 * de la carpeta»). En vez de que el agente principal recorra los elementos uno
 * por uno (y llene su contexto), esta herramienta reparte una sub-ejecución
 * corta por elemento, de a `concurrency` a la vez, y devuelve UNA tabla.
 *
 * LÍMITES (todos duros):
 *   - hasta 50 elementos por llamada;
 *   - 6 piezas a la vez (máx. 8);
 *   - por pieza: `maxStepsPerItem` pasos (5 por defecto, máx. 8) y 45 s;
 *   - tope total de tokens = elementos × TOKENS_PER_ITEM_CAP: al pasarlo no se
 *     empiezan más piezas;
 *   - tiempo: no se EMPIEZAN piezas pasados START_WINDOW_MS ni cuando al turno
 *     le queda poco (`ctx.turnMsLeft`, ver lib/turn-budget.ts). Lo que falta se
 *     devuelve en `pending` con «faltan N» y `runInBackground: true`.
 *
 * SEGURIDAD: SOLO herramientas de lectura (allowlist.ts). Nada de efectos, y
 * nadie puede confirmar nada dentro de una pieza.
 */

export const MAX_ITEMS = 50;
export const DEFAULT_CONCURRENCY = 6;
export const ITEM_TIMEOUT_MS = 45_000;
/** Dejar de EMPEZAR piezas pasado esto (la herramienta entera muere a los 180 s). */
export const START_WINDOW_MS = 100_000;
/** Mientras corre, la herramienta nunca pasa de esto (TOOL_MAX_MS de turn-budget, con margen). */
export const TOOL_WINDOW_MS = 165_000;
/** Con menos que esto de turno restante no se empieza otra pieza. */
export const TURN_RESERVE_MS = 45_000;
export const TOKENS_PER_ITEM_CAP = 40_000;

const fieldSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,30}$/, 'minúsculas, números y _; empieza con letra')
    .describe('Clave corta del campo, p. ej. "precio_unitario".'),
  label: z.string().min(1).max(60).describe('Nombre de la columna en español: «Precio unitario».'),
  kind: z.enum(['text', 'number', 'money', 'date']).default('text'),
  description: z
    .string()
    .max(200)
    .optional()
    .describe('Qué buscar exactamente (unidad, formato, dónde mirar).'),
});

const itemSchema = z.object({
  id: z.string().min(1).max(40).describe('Id estable del elemento (NIT, código, nombre corto).'),
  label: z.string().min(1).max(160).describe('Cómo se muestra en la tabla.'),
  context: z
    .string()
    .max(1500)
    .optional()
    .describe('Datos del elemento que la pieza necesita (URL, id de documento, referencia).'),
});

const inputSchema = z.object({
  goal: z.string().min(5).max(500).describe('Para qué es la investigación, en una frase.'),
  instructions: z
    .string()
    .min(5)
    .max(3000)
    .describe(
      'Qué hacer con CADA elemento: dónde mirar y cómo decidir. Es el mismo texto para todos.',
    ),
  items: z.array(itemSchema).min(1).max(MAX_ITEMS),
  fields: z
    .array(fieldSchema)
    .min(1)
    .max(8)
    .describe('El esquema de salida: qué datos sacar de cada elemento (columnas de la tabla).'),
  model: z
    .enum(['fast', 'standard'])
    .default('fast')
    .describe('fast = modelo barato (por defecto); standard = más criterio por pieza, más caro.'),
  maxStepsPerItem: z.number().int().min(1).max(8).default(5),
  concurrency: z.number().int().min(1).max(8).default(DEFAULT_CONCURRENCY),
});

const rowSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['Listo', 'Parcial', 'Sin dato', 'Error']),
  values: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  notes: z.string(),
  sources: z.string(),
});

const outputSchema = z.object({
  goal: z.string(),
  columns: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      kind: z.enum(['text', 'number', 'date', 'money']),
    }),
  ),
  rows: z.array(rowSchema),
  summary: z.string(),
  counts: z.object({
    requested: z.number(),
    processed: z.number(),
    complete: z.number(),
    partial: z.number(),
    noData: z.number(),
    error: z.number(),
  }),
  remaining: z.number(),
  pending: z.array(z.object({ id: z.string(), label: z.string(), context: z.string().optional() })),
  stopReason: z.enum(['tiempo', 'presupuesto', 'cancelado']).nullable(),
  runInBackground: z.boolean(),
  usage: z.object({
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
    subRuns: z.number(),
    toolCalls: z.number(),
  }),
  model: z.string(),
  elapsedMs: z.number(),
});

/** Quita ids repetidos conservando el primero; lanza si hay una repetición real. */
export function assertUniqueIds(items: readonly ResearchItem[]): void {
  const seen = new Set<string>();
  for (const it of items) {
    if (seen.has(it.id))
      throw new ValidationError(
        `Id repetido en items: «${it.id}». Cada elemento necesita un id único.`,
      );
    seen.add(it.id);
  }
}

export interface ResearchDeps {
  generate?: GenerateFn;
  now?: () => number;
}

/** El cuerpo, separado de `registerTool` para probarlo con un generador falso. */
export async function runResearch(
  raw: z.input<typeof inputSchema>,
  ctx: ToolContext,
  deps: ResearchDeps = {},
): Promise<ResearchResult> {
  // Aplica los valores por omisión (el handler recibe el tipo de entrada).
  const input = inputSchema.parse(raw);
  assertUniqueIds(input.items);
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const tier = input.model;
  const generate = deps.generate ?? defaultGenerate(researchModel(tier));
  const allowed = researchToolsFrom(listTools(), ctx.grantedToolIds);
  const fields = input.fields;
  const tokenCap = input.items.length * TOKENS_PER_ITEM_CAP;
  const items = input.items as ResearchItem[];

  let spent = 0;
  const elapsed = () => now() - startedAt;
  const turnLeft = () => ctx.turnMsLeft?.() ?? Number.POSITIVE_INFINITY;

  const outcomes = new Map<number, ItemOutcome>();

  const pool = await runPool(
    items,
    async (item, index) => {
      // Tiempo propio de esta pieza: nunca más de lo que le queda a la herramienta ni al turno.
      const room = Math.min(TOOL_WINDOW_MS - elapsed(), turnLeft() - 5_000);
      const outcome = await runItem({
        item,
        goal: input.goal,
        instructions: input.instructions,
        fields,
        allowed,
        ctx,
        generate,
        maxSteps: input.maxStepsPerItem,
        timeoutMs: Math.min(ITEM_TIMEOUT_MS, room),
      });
      spent += outcome.promptTokens + outcome.completionTokens;
      outcomes.set(index, outcome);
      // Una fila de auditoría por pieza (las herramientas de lectura que usó ya
      // escribieron las suyas dentro de runTool).
      await writeAuditEvent({
        db: ctx.db,
        userId: ctx.userId,
        agentId: ctx.agentId,
        ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
        toolId: 'research.item',
        input: { id: item.id, goal: input.goal },
        status: outcome.status === 'Error' ? 'error' : 'ok',
        latencyMs: outcome.ms,
        ...(ctx.surface ? { surface: ctx.surface } : {}),
        metadata: {
          status: outcome.status,
          steps: outcome.steps,
          toolCalls: outcome.toolCalls,
          promptTokens: outcome.promptTokens,
          completionTokens: outcome.completionTokens,
          model: tier,
          ...(outcome.error ? { error: outcome.error } : {}),
        },
      });
      return outcome;
    },
    {
      concurrency: input.concurrency,
      shouldStop: () => {
        if (ctx.signal?.aborted) return 'cancelado';
        if (elapsed() >= START_WINDOW_MS || turnLeft() < TURN_RESERVE_MS) return 'tiempo';
        if (spent >= tokenCap) return 'presupuesto';
        return null;
      },
      onSettled: (_s, done) => ctx.onProgress?.(`Investigando: ${done} de ${items.length} listos…`),
    },
  );

  const done = pool.settled.map((s) => ({
    item: items[s.index] as ResearchItem,
    outcome:
      outcomes.get(s.index) ??
      ({
        status: 'Error',
        values: {},
        notes: '',
        sources: [],
        promptTokens: 0,
        completionTokens: 0,
        steps: 0,
        toolCalls: 0,
        ms: 0,
        error: s.error instanceof Error ? s.error.message : 'La pieza falló.',
      } satisfies ItemOutcome),
  }));

  return buildResult({
    goal: input.goal,
    fields,
    items,
    done,
    notStarted: pool.notStarted.map((i) => items[i] as ResearchItem),
    stopReason: pool.stopReason as StopReason,
    model: tier,
    elapsedMs: elapsed(),
  });
}

export const researchParallel = registerTool({
  id: 'research.parallel',
  description:
    'INVESTIGACIÓN EN PARALELO para tareas de AMPLITUD: la misma pregunta sobre muchos elementos (comparar 30 proveedores, revisar 200 facturas o contratos, buscar precio y entrega de 15 productos, resumir cada documento de una carpeta). Reparte una sub-ejecución corta por elemento (6 a la vez, máx. 50 elementos) y devuelve UNA tabla con los campos que pidas (`fields`), estado por fila y fuentes, más totales de tokens. SOLO LECTURA: web, cerebro, tablas, libro, correo, Drive y similares; jamás envía, escribe ni abre el navegador, y nadie puede aprobar nada dentro. NO la uses para pocos elementos (menos de ~5: hazlo tú), para acciones con efectos, ni para una pregunta que no se repite por elemento. Si el tiempo del turno no alcanza devuelve lo hecho, `remaining` («faltan N») y `pending` con los elementos que faltan: vuelve a llamarla con ESOS elementos (y junta las tablas al responder) o propón correrlo como tarea en segundo plano.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 3 },
  handler: async (input, ctx) => {
    if (!process.env.ANTHROPIC_API_KEY)
      throw new IntegrationError('ANTHROPIC_API_KEY not configured', 'anthropic');
    return runResearch(input, ctx);
  },
});
