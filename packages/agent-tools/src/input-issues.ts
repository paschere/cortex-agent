import type { z } from 'zod';

/**
 * EL ERROR DE VALIDACIÓN, LEGIBLE PARA QUIEN LO CORRIGE.
 *
 * Antes la herramienta devolvía «Invalid input for trackers.upsert» y nada más:
 * el modelo no sabía QUÉ campo faltaba ni cuál sobraba, y el 2026-10-19
 * concluyó «no tengo herramienta para escribir filas» después de mandar `rows`
 * a una herramienta que recibe `values`. Ahora el mensaje, en español, dice qué
 * campos fallan y por qué, qué campos mandó que la herramienta no conoce y cuáles
 * sí acepta.
 */

type AnyRecord = Record<string, unknown>;

const MAX_ISSUES = 6;

/** Las claves de primer nivel que acepta un esquema (a través de refine/transform/default). */
export function schemaKeys(schema: unknown, depth = 0): string[] | null {
  if (!schema || typeof schema !== 'object' || depth > 5) return null;
  const def = (schema as AnyRecord)._def as AnyRecord | undefined;
  const shape =
    (schema as AnyRecord).shape ??
    (def && typeof def.shape === 'function' ? (def.shape as () => unknown)() : def?.shape);
  if (shape && typeof shape === 'object') return Object.keys(shape as AnyRecord);
  const inner = def?.schema ?? def?.innerType ?? def?.in;
  return inner ? schemaKeys(inner, depth + 1) : null;
}

function plainIssue(issue: z.ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '';
  let text: string = issue.message;
  if (issue.code === 'invalid_type' && (issue as { received?: string }).received === 'undefined')
    text = 'es obligatorio y no vino';
  else if (issue.code === 'invalid_type')
    text = `debe ser ${(issue as { expected?: string }).expected ?? 'otro tipo'} (llegó ${(issue as { received?: string }).received ?? 'otra cosa'})`;
  else if (issue.code === 'unrecognized_keys')
    text = `campos desconocidos: ${(issue as { keys?: string[] }).keys?.join(', ')}`;
  return path ? `${path}: ${text}` : text;
}

export function describeInputIssues(
  toolId: string,
  schema: unknown,
  input: unknown,
  error: z.ZodError,
): string {
  const sdkName = toolId.replaceAll('.', '_');
  const lines = error.issues.slice(0, MAX_ISSUES).map(plainIssue);
  const rest = error.issues.length - lines.length;
  const accepted = schemaKeys(schema);
  const sent =
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.keys(input as AnyRecord)
      : [];
  const unknown = accepted ? sent.filter((k) => !accepted.includes(k)) : [];
  const extra = [
    unknown.length > 0
      ? ` Mandaste campos que ${sdkName} no tiene: ${unknown.join(', ')} (se ignoran).`
      : '',
    accepted ? ` Campos que acepta: ${accepted.join(', ')}.` : '',
  ].join('');
  return `Datos inválidos para ${sdkName} — ${lines.join('; ')}${rest > 0 ? ` (y ${rest} más)` : ''}.${extra} Corrige y vuelve a llamar la MISMA herramienta; no concluyas que no existe.`;
}
