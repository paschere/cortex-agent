/**
 * EL SEGUNDO LECTOR.
 *
 * ===========================================================================
 * QUÉ ARREGLA
 * ===========================================================================
 * Un embedding comprime un pasaje entero en un punto, de una vez y sin haber
 * visto nunca la pregunta. Es lo que lo hace barato —se calcula al indexar— y
 * es también su techo: dos pasajes que hablan del mismo tema quedan cerca el
 * uno del otro aunque sólo uno CONTESTE. Por eso una búsqueda por significado
 * trae casi siempre el material correcto y casi nunca en el orden correcto.
 *
 * Un reordenador lee la pregunta y el pasaje JUNTOS, uno por uno. Cuesta una
 * llamada más y no se puede precalcular, así que no sirve para buscar entre un
 * millón de trozos — pero sobre los veinte que ya trajo la búsqueda es
 * exactamente la lectura que faltaba: «de estos veinte, ¿cuáles responden?».
 *
 * ===========================================================================
 * LO QUE ESTE MÓDULO TIENE PROHIBIDO
 * ===========================================================================
 *   1. NO PUEDE AÑADIR. Devuelve una permutación de lo que recibió, siempre.
 *      Un reordenador que pudiera meter material sería una segunda búsqueda sin
 *      las comprobaciones de permisos de la primera.
 *   2. NO PUEDE FILTRAR. Quién se queda fuera lo decide el corte de
 *      `searchSpaces` y el suelo de relevancia de `relevance.ts`, que están
 *      medidos. Este módulo dice el ORDEN y nada más.
 *   3. NO TOCA LAS PUNTUACIONES. `semanticScore` es un coseno, y los umbrales
 *      de relevance.ts están calibrados contra ese coseno, por modelo. Meter
 *      aquí una puntuación de otra escala haría que esos umbrales dejaran de
 *      significar nada — que es el fallo que la 0074 documenta para los
 *      embeddings y que no hay razón para repetir.
 *   4. NO PUEDE COSTAR UNA RESPUESTA. Sin llave, con la llave equivocada, con
 *      el proveedor caído o simplemente lento, devuelve el orden que recibió.
 *      Un reordenador es una mejora de la recuperación, nunca un requisito.
 */

import type { Logger } from '@cortex/core';

/**
 * El modelo. `rerank-2.5-lite` y no el grande: sobre veinte candidatos la
 * diferencia de calidad entre los dos es pequeña y la de latencia no lo es, y
 * esto corre en mitad de un turno con alguien esperando.
 */
const MODEL = process.env.KB_RERANK_MODEL ?? 'rerank-2.5-lite';

const URL = 'https://api.voyageai.com/v1/rerank';

/**
 * Cuánto se manda de cada pasaje. Un trozo son ~400 tokens, así que esto casi
 * nunca corta; está para que un trozo anómalo —una tabla enorme, un volcado— no
 * convierta una llamada barata en una cara.
 */
const MAX_CHARS = 4000;

/**
 * El tiempo que se le concede. Pasado esto se sigue con el orden que ya había:
 * una respuesta un poco peor ordenada, ahora, vale más que una bien ordenada
 * cuatro segundos tarde — y la persona no puede distinguir cuál recibió.
 */
const TIMEOUT_MS = Number(process.env.KB_RERANK_TIMEOUT_MS ?? 4000);

/** ¿Está encendido? Sin llave no, y con `KB_RERANK=off` tampoco. */
export function rerankerAvailable(): boolean {
  if ((process.env.KB_RERANK ?? '').toLowerCase() === 'off') return false;
  return Boolean(process.env.VOYAGE_API_KEY);
}

export interface RerankUsage {
  model: string;
  totalTokens: number;
}

export type RerankOutcome =
  | { ok: true; order: number[]; usage: RerankUsage }
  | { ok: false; reason: string };

/**
 * Pide el orden. Devuelve ÍNDICES sobre la lista que recibió, nunca los textos:
 * así quien llama conserva sus objetos completos (con su chunkId, su espacio y
 * sus puntuaciones) y este módulo no tiene forma de alterarlos aunque quisiera.
 */
export async function rerankPassages(
  query: string,
  passages: string[],
  opts: { signal?: AbortSignal } = {},
): Promise<RerankOutcome> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return { ok: false, reason: 'no hay llave de Voyage' };
  if (passages.length < 2) return { ok: false, reason: 'no hay nada que reordenar' };

  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), TIMEOUT_MS);
  // Si quien llama ya cancela, esta llamada se cancela con él.
  opts.signal?.addEventListener('abort', () => timer.abort(), { once: true });

  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: query.slice(0, 4000),
        documents: passages.map((p) => p.slice(0, MAX_CHARS)),
        model: MODEL,
        // Sin `top_k`: se quiere el orden de TODOS, porque el corte lo hace
        // quien llama y pedirle al proveedor que corte sería darle el poder que
        // el punto 2 de la cabecera le niega.
      }),
      signal: timer.signal,
    });

    if (!r.ok) {
      return { ok: false, reason: `Voyage ${r.status}: ${(await r.text()).slice(0, 200)}` };
    }

    const body = (await r.json()) as {
      data?: Array<{ index?: number; relevance_score?: number }>;
      usage?: { total_tokens?: number };
    };

    const rows = body.data ?? [];
    if (rows.length === 0) return { ok: false, reason: 'Voyage devolvió un orden vacío' };

    // La respuesta viene ya ordenada de más a menos relevante. Se valida igual
    // en vez de confiarse: un índice fuera de rango o repetido convertiría una
    // permutación en una pérdida de resultados, en silencio.
    const seen = new Set<number>();
    const order: number[] = [];
    for (const row of rows) {
      const i = row.index;
      if (typeof i !== 'number' || i < 0 || i >= passages.length || seen.has(i)) continue;
      seen.add(i);
      order.push(i);
    }
    // Lo que el proveedor no mencionó se queda detrás, en su orden original: la
    // salida tiene que contener exactamente lo que entró.
    for (let i = 0; i < passages.length; i += 1) if (!seen.has(i)) order.push(i);

    return {
      ok: true,
      order,
      usage: { model: MODEL, totalTokens: body.usage?.total_tokens ?? 0 },
    };
  } catch (err) {
    const reason =
      (err as Error)?.name === 'AbortError'
        ? `el reordenador tardó más de ${TIMEOUT_MS} ms`
        : ((err as Error)?.message ?? 'el reordenador falló');
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * El envoltorio que usa la búsqueda: reordena una lista de objetos por su texto.
 * Nunca lanza y nunca cambia el conjunto — como mucho, no hace nada.
 */
export async function rerankByMeaning<T>(
  query: string,
  items: T[],
  textOf: (item: T) => string,
  opts: { logger?: Logger; signal?: AbortSignal } = {},
): Promise<T[]> {
  if (!rerankerAvailable() || items.length < 2) return items;

  const outcome = await rerankPassages(
    query,
    items.map(textOf),
    opts.signal ? { signal: opts.signal } : {},
  );
  if (!outcome.ok) {
    opts.logger?.warn({ reason: outcome.reason }, 'kb: el reordenador no corrió; va el orden base');
    return items;
  }
  return outcome.order.map((i) => items[i] as T);
}
