/**
 * La lógica pura del borrado de documentos: qué blob acompaña a cada fila,
 * qué lote es válido, y cómo se cuenta el resultado en una frase.
 *
 * Vive aparte de actions.ts por dos razones: un módulo 'use server' solo puede
 * exportar funciones async (aquí hay constantes y funciones síncronas), y esta
 * parte es la que merece pruebas sin montar una base de datos.
 */

/** El bucket donde /api/kb/documents guarda los archivos subidos. */
export const KB_BUCKET = 'kb-uploads';

/**
 * Tope por llamada del borrado en lote. Cien es más que cualquier espacio real
 * de hoy; por encima de eso el problema es otro (borrar el espacio entero) y
 * existe deleteSpace para eso.
 */
export const MAX_BATCH_DELETE = 100;

/**
 * Los orígenes cuyo `source_ref` es una ruta dentro de 'kb-uploads'. La lista
 * calca lo que escribe POST /api/kb/documents: 'upload' para texto, 'audio' y
 * 'recording' para lo hablado (que además repite la ruta en `media_path`).
 * Para 'gdrive' el `source_ref` es un id de Drive y para 'meeting'/'url' no
 * hay binario nuestro — borrar por esas "rutas" sería borrar nada o, peor,
 * una ruta ajena que casualmente coincida.
 */
const BLOB_SOURCES = new Set(['upload', 'audio', 'recording']);

/** Las rutas de 'kb-uploads' que quedarían huérfanas si esta fila se borra. */
export function blobPathsOf(doc: {
  source: string | null;
  source_ref: string | null;
  media_path: string | null;
}): string[] {
  if (!BLOB_SOURCES.has(doc.source ?? '')) return [];
  const paths = new Set<string>();
  if (doc.source_ref) paths.add(doc.source_ref);
  // En audio ambas columnas llevan la misma ruta; el Set ya deduplica.
  if (doc.media_path) paths.add(doc.media_path);
  return [...paths];
}

/**
 * Deja el lote en una forma sobre la que valga la pena iterar: solo strings
 * con contenido, sin repetidos, y dentro del tope. Un lote fuera del tope se
 * rechaza entero en vez de recortarse en silencio — "borré lo que me cupo" es
 * exactamente la clase de mentira parcial que este flujo evita.
 */
export function normalizeBatchIds(
  documentIds: readonly unknown[],
): { ok: true; ids: string[] } | { ok: false; error: string } {
  const ids = [
    ...new Set(
      documentIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
    ),
  ];
  if (ids.length === 0) return { ok: false, error: 'No hay nada seleccionado.' };
  if (ids.length > MAX_BATCH_DELETE) {
    return {
      ok: false,
      error: `Son demasiados de una vez (máximo ${MAX_BATCH_DELETE}). Borra por tandas o borra el espacio entero.`,
    };
  }
  return { ok: true, ids };
}

export interface BatchRejection {
  id: string;
  reason: string;
}

/** Lo que devuelve el borrado en lote cuando la llamada en sí funcionó. */
export interface BatchDeleteResult {
  ok: true;
  borrados: number;
  rechazados: BatchRejection[];
}

/**
 * El resultado parcial dicho de frente: «8 borrados, 2 se quedaron (…)».
 * Las razones se deduplican porque diez documentos ajenos fallan con la misma
 * frase, y repetirla diez veces no la hace más cierta.
 */
export function describeOutcome(borrados: number, rechazados: BatchRejection[]): string {
  const done = borrados === 1 ? '1 borrado' : `${borrados} borrados`;
  if (rechazados.length === 0) return `Listo: ${done}.`;
  const reasons = [...new Set(rechazados.map((r) => r.reason))].join(' · ');
  if (borrados === 0) {
    return rechazados.length === 1
      ? `No se borró: ${reasons}`
      : `No se borró ninguno de los ${rechazados.length}: ${reasons}`;
  }
  const kept = rechazados.length === 1 ? '1 se quedó' : `${rechazados.length} se quedaron`;
  return `${done}; ${kept} (${reasons})`;
}
