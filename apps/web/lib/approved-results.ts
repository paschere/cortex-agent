/**
 * LO QUE SE APROBÓ, DE VUELTA AL MODELO.
 *
 * Cuando la persona aprueba una tarjeta, la ruta /api/chat/confirm ejecuta la
 * herramienta y guarda el resultado en `messages.tool_results`; la tarjeta
 * escribe por la persona «Aprobé y ya se ejecutó… continúa desde ahí». Pero el
 * historial entre turnos es TEXTO: el modelo leía «ya se ejecutó» sin saber
 * QUÉ salió — el slug de la tabla recién creada, el id de la vista, la URL de
 * la app. En un pedido de varios pasos (tabla → vista → app) el paso siguiente
 * no tenía con qué seguir y volvía a pedir o se perdía.
 *
 * Esto arma un resumen corto y legible de esos resultados para pegarlo, sólo
 * del lado del servidor, al mensaje de control. La persona no lo ve.
 */

interface ToolResultEntry {
  toolName?: unknown;
  toolCallId?: unknown;
  result?: unknown;
}

/** Campos que identifican lo creado o cambiado: lo que el paso siguiente necesita. */
const KEY_FIELDS = [
  'id',
  'slug',
  'name',
  'title',
  'label',
  'url',
  'path',
  'status',
  'message',
  'summary',
  'count',
  'created',
  'updated',
] as const;

const NESTED = [
  'table',
  'tracker',
  'view',
  'app',
  'record',
  'row',
  'item',
  'result',
  'data',
] as const;

function pickFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEY_FIELDS) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') out[k] = v.length > 160 ? `${v.slice(0, 157)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Lo esencial de un resultado, en una línea corta. */
export function compactResult(result: unknown, max = 600): string {
  if (result === null || result === undefined) return 'sin resultado';
  if (typeof result !== 'object') return String(result).slice(0, max);
  const r = result as Record<string, unknown>;
  if (r.__error) return `falló: ${String(r.message ?? 'error')}`.slice(0, max);
  const top = pickFields(r);
  for (const key of NESTED) {
    const nested = r[key];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const picked = pickFields(nested as Record<string, unknown>);
      if (Object.keys(picked).length) top[key] = picked;
    } else if (Array.isArray(nested)) {
      top[key] = `${nested.length} elementos`;
    }
  }
  const text = Object.keys(top).length ? JSON.stringify(top) : JSON.stringify(r);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * El bloque que se pega al mensaje de control: un renglón por herramienta ya
 * ejecutada (ni las que siguen esperando aprobación ni las que están corriendo).
 * Vacío si no hay nada que contar.
 */
export function approvedResultsBlock(toolResults: unknown): string {
  if (!Array.isArray(toolResults)) return '';
  const lines: string[] = [];
  for (const entry of toolResults as ToolResultEntry[]) {
    const result = entry?.result as Record<string, unknown> | undefined;
    if (!result || typeof result !== 'object') continue;
    if (result.__requires_confirmation || result.__confirmation_in_progress) continue;
    const name = typeof entry.toolName === 'string' ? entry.toolName : 'herramienta';
    lines.push(`- ${name}: ${compactResult(result)}`);
  }
  if (!lines.length) return '';
  return [
    '[Resultado de lo que la persona acaba de aprobar. Úsalo para seguir con el siguiente paso de lo que pidió; no lo vuelvas a ejecutar ni a pedir.]',
    ...lines.slice(-8),
  ].join('\n');
}
