import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * LO QUE CONSUMIÓ CADA LLAMADA AL MODELO, PARA PONERLE PRECIO (0228).
 *
 * `turn_latencies` ya sabe cuánto tardó un turno y guarda los tokens, pero
 * caduca a los 90 días, sólo existe para el chat y no sabe de tareas en segundo
 * plano. Esto es el libro de consumo: UNA fila por turno de chat o por tanda de
 * una tarea, con el modelo y los cuatro números que deciden el precio —entrada
 * sin caché, lectura de caché, escritura de caché, salida—. Son enteros, no
 * hay texto, y no caduca: la pregunta «cuánto nos cuesta Cortex» no se pierde
 * a los tres meses.
 *
 * Escribir esto NUNCA puede tumbar un turno: se traga todo error y avisa por
 * el logger (una migración sin aplicar no debe romper el chat).
 */

export type UsageSource = 'chat' | 'task' | 'errand' | 'other';

export interface ModelUsageInput {
  userId: string | null;
  conversationId?: string | null;
  taskId?: string | null;
  messageId?: string | null;
  surface?: string;
  source?: UsageSource;
  model: string;
  steps?: number;
  /** Entrada que NO vino del caché. */
  inputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  outputTokens: number;
  occurredAt?: string;
  /**
   * El experimento de modelos (0236). `arm` es el brazo asignado a la
   * conversación ('haiku' | 'sonnet'; null fuera del experimento); los
   * contadores son de ESTE turno.
   */
  experiment?: {
    arm: 'haiku' | 'sonnet' | null;
    toolErrors: number;
    retries: number;
    refusals: number;
    fellBack: boolean;
  };
}

const clampInt = (n: number | undefined): number =>
  Number.isFinite(n) && (n as number) > 0 ? Math.round(n as number) : 0;

/** Suma los pasos de caché de un turno en las tres cifras de entrada. */
export function sumCacheSteps(
  steps: ReadonlyArray<{ read?: number; written?: number; promptTokens?: number }>,
): { input: number; cacheRead: number; cacheWrite: number } {
  let input = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const s of steps) {
    input += clampInt(s.promptTokens);
    cacheRead += clampInt(s.read);
    cacheWrite += clampInt(s.written);
  }
  return { input, cacheRead, cacheWrite };
}

/** Los tokens de caché que el proveedor de Anthropic puso en los metadatos de un paso. */
export function anthropicStepCache(
  meta: Record<string, Record<string, unknown> | undefined> | undefined,
): { read: number; written: number } {
  const a = meta?.anthropic;
  const read = a?.cacheReadInputTokens;
  const written = a?.cacheCreationInputTokens;
  return {
    read: typeof read === 'number' ? read : 0,
    written: typeof written === 'number' ? written : 0,
  };
}

export async function recordModelUsage(
  db: SupabaseClient,
  input: ModelUsageInput,
  logger?: { warn: (obj: unknown, msg?: string) => void },
): Promise<void> {
  try {
    const row = {
      user_id: input.userId,
      conversation_id: input.conversationId ?? null,
      task_id: input.taskId ?? null,
      message_id: input.messageId ?? null,
      surface: input.surface ?? 'web',
      source: input.source ?? 'chat',
      model: input.model,
      steps: Math.max(clampInt(input.steps), 1),
      input_tokens: clampInt(input.inputTokens),
      cache_read_tokens: clampInt(input.cacheReadTokens),
      cache_write_tokens: clampInt(input.cacheWriteTokens),
      output_tokens: clampInt(input.outputTokens),
      ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
    };
    if (row.input_tokens + row.cache_read_tokens + row.cache_write_tokens + row.output_tokens === 0)
      return;
    const e = input.experiment;
    const extras = e
      ? {
          experiment_arm: e.arm,
          tool_errors: clampInt(e.toolErrors),
          retries: clampInt(e.retries),
          refusals: clampInt(e.refusals),
          fell_back: e.fellBack,
        }
      : null;
    const { error } = await db.from('model_usage').insert(extras ? { ...row, ...extras } : row);
    if (error && extras) {
      // Migración 0236 sin aplicar: el consumo (lo que cuesta) no se pierde por
      // las columnas del experimento.
      const retry = await db.from('model_usage').insert(row);
      if (retry.error) logger?.warn({ err: retry.error }, 'model_usage insert failed');
    } else if (error) {
      logger?.warn({ err: error }, 'model_usage insert failed');
    }
  } catch (err) {
    logger?.warn({ err }, 'model_usage capture threw');
  }
}
