import 'server-only';
import { buildToolContext } from '@/lib/agent';
import {
  type Suggestion,
  type TrackerField,
  checkMeter,
  consumeToken,
  getTool,
  getTrackerBySlug,
  isRefused,
  isToolAvailable,
  runTool,
  sanitizeSuggestion,
  simpleModel,
  triggerSignature,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { type UUID, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type CoreTool, generateText, tool } from 'ai';
import { z } from 'zod';

/**
 * AUTOFILL POR CORTEX: el turno corto de modelo detrás de «Llenar con Cortex».
 *
 * El navegador manda los valores de los campos disparadores (`from`); aquí un
 * turno de modelo, con herramientas de SÓLO LECTURA (web, vuelos si hay llave,
 * otras tablas), propone valores para los campos `fills`. Nada se escribe: el
 * formulario los muestra como sugerencia y la persona decide (y no pisan lo ya
 * escrito: ver autofill-shape.ts). Tope de ~15 s, caché por valor disparador,
 * tope por minuto por persona y por día por empresa. Los errores salen en
 * español, sin detalle técnico.
 */

export class AutofillError extends Error {}

const TIME_LIMIT_MS = 15_000;
const PER_MINUTE = 8;
export const AUTOFILL_PER_DAY = 300;
const CACHE_TTL_MS = 15 * 60_000;
const READ_TOOLS = ['web.search', 'web.scrape', 'flights.lookup', 'trackers.query'] as const;

const cache = new Map<string, { at: number; out: AutofillOutput }>();

export interface AutofillOutput {
  suggestions: Record<string, Suggestion>;
  note: string | null;
}

export async function runAutofill(input: {
  organizationId: string;
  userId: string;
  db: SupabaseClient;
  trackerSlug: string;
  fieldKey: string;
  values: Record<string, string>;
  signal?: AbortSignal;
}): Promise<AutofillOutput & { cached: boolean }> {
  const { db } = input;
  const tracker = await getTrackerBySlug(db, input.trackerSlug);
  const field = tracker?.fields.find((f) => f.key === input.fieldKey);
  const config = field?.autofill;
  if (!tracker || !field || !config) throw new AutofillError('Ese campo no se llena con Cortex.');
  const have = Object.fromEntries(
    config.from.map((k) => [
      k,
      String(input.values[k] ?? '')
        .trim()
        .slice(0, 400),
    ]),
  );
  if (config.from.some((k) => !have[k]))
    throw new AutofillError('Completa primero los datos con los que Cortex va a buscar.');

  const key = `${input.organizationId}:${tracker.slug}:${field.key}:${triggerSignature(config, have)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.out, cached: true };

  // Topes: por persona y minuto, por empresa y día, y las respuestas del plan.
  try {
    await consumeToken(db, input.userId, 'trackers.autofill', PER_MINUTE);
  } catch {
    throw new AutofillError('Muchas búsquedas seguidas. Espera un momento.');
  }
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count, error: countError } = await db
    .from('audit_events')
    .select('id', { count: 'exact', head: true })
    .eq('tool_id', 'trackers.autofill')
    .gte('created_at', since);
  if (countError) throw new AutofillError('Cortex no pudo llenarlo ahora. Llénalo a mano.');
  if ((count ?? 0) >= AUTOFILL_PER_DAY)
    throw new AutofillError(
      'La empresa llegó al tope de llenados con Cortex de hoy. Escríbelos a mano.',
    );
  if (isRefused(await checkMeter(db, 'answers')))
    throw new AutofillError('El plan de la empresa no tiene respuestas disponibles.');

  const started = Date.now();
  const fills = config.fills
    .map((k) => tracker.fields.find((f) => f.key === k))
    .filter((f): f is TrackerField => Boolean(f));

  const { data: agent, error: agentError } = await db
    .from('agents')
    .select('id')
    .eq('slug', 'cortex')
    .eq('archived', false)
    .maybeSingle();
  if (agentError) logger.warn({ err: agentError }, 'autofill: agent lookup failed');
  const ctx = buildToolContext({
    organizationId: input.organizationId,
    userId: input.userId as UUID,
    agentId: ((agent as { id?: string } | null)?.id ?? input.userId) as UUID,
    surface: 'web',
  });
  const timeout = AbortSignal.timeout(TIME_LIMIT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  ctx.signal = signal;

  const tools: Record<string, CoreTool> = {};
  for (const id of READ_TOOLS) {
    const def = getTool(id);
    if (!def || !isToolAvailable(def)) continue;
    tools[id.replaceAll('.', '_')] = tool({
      description: def.description,
      parameters: def.inputSchema,
      execute: async (args) => {
        try {
          return await runTool(def, args, { ...ctx, signal });
        } catch (err) {
          logger.warn({ err, tool: id }, 'autofill: tool failed');
          return { __error: true, message: 'Esa consulta no funcionó.' } as unknown as never;
        }
      },
    });
  }
  tools.entregar_valores = tool({
    description:
      'Entrega los valores encontrados y termina. Un valor por campo destino; null si no lo encontraste con seguridad. `source` es la URL o la tabla de donde salió.',
    parameters: z.object({
      values: z.record(
        z.object({ value: z.string().nullable(), source: z.string().max(300).optional() }),
      ),
      note: z.string().max(200).optional(),
    }),
  });

  const system =
    'Eres Cortex llenando campos de una tabla de la empresa. Sigue la instrucción, usa SOLO las herramientas de lectura para buscar y termina SIEMPRE llamando a entregar_valores. No inventes: si no lo encuentras con seguridad, devuelve null en ese campo. Fechas YYYY-MM-DD, horas HH:MM de 24 h (hora local del lugar de la tabla, Colombia si no se sabe), números sin símbolos. Para campos de opciones usa exactamente una de las opciones. Sé breve: máximo 4 llamadas a herramientas.';
  const prompt = JSON.stringify({
    hoy: new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10),
    instruccion: config.instruction,
    datos: Object.fromEntries(config.from.map((k) => [k, have[k]])),
    campos_a_llenar: fills.map((f) => ({
      clave: f.key,
      nombre: f.label,
      tipo: f.type,
      ...(f.options?.length ? { opciones: f.options } : {}),
    })),
  });

  type Delivered = {
    values: Record<string, { value: string | null; source?: string }>;
    note?: string;
  };
  const box: { d: Delivered | null } = { d: null };
  try {
    const result = await generateText({
      abortSignal: signal,
      model: simpleModel(),
      system,
      prompt,
      tools,
      toolChoice: 'auto',
      maxSteps: 6,
      maxTokens: 1200,
    });
    for (const step of result.steps ?? []) {
      for (const call of step.toolCalls ?? []) {
        if (call.toolName === 'entregar_valores') box.d = call.args as Delivered;
      }
    }
  } catch (err) {
    logger.warn({ err, tracker: tracker.slug }, 'autofill: model turn failed');
    await writeAuditEvent({
      db,
      userId: input.userId as UUID,
      toolId: 'trackers.autofill',
      input: { tracker: tracker.slug, field: field.key },
      status: 'error',
      latencyMs: Date.now() - started,
      surface: 'web',
      decision: 'allowed',
      metadata: { tracker: tracker.slug, field: field.key },
    });
    throw new AutofillError(
      timeout.aborted
        ? 'Cortex tardó demasiado buscando. Intenta otra vez o llena a mano.'
        : 'Cortex no pudo llenarlo ahora. Llénalo a mano o intenta de nuevo.',
    );
  }

  const delivered = box.d;
  const suggestions: Record<string, Suggestion> = {};
  for (const f of fills) {
    const got = delivered?.values?.[f.key];
    const clean = got?.value ? sanitizeSuggestion(f, got.value) : null;
    if (clean)
      suggestions[f.key] = { value: clean, ...(got?.source ? { source: got.source } : {}) };
  }
  const out: AutofillOutput = {
    suggestions,
    note:
      Object.keys(suggestions).length === 0
        ? (delivered?.note ?? 'Cortex no encontró datos con seguridad. Llénalos a mano.')
        : (delivered?.note ?? null),
  };
  await writeAuditEvent({
    db,
    userId: input.userId as UUID,
    toolId: 'trackers.autofill',
    input: { tracker: tracker.slug, field: field.key },
    status: 'ok',
    latencyMs: Date.now() - started,
    surface: 'web',
    decision: 'allowed',
    metadata: { tracker: tracker.slug, field: field.key, filled: Object.keys(suggestions) },
  });
  if (Object.keys(suggestions).length) {
    if (cache.size > 300) cache.clear();
    cache.set(key, { at: Date.now(), out });
  }
  return { ...out, cached: false };
}
