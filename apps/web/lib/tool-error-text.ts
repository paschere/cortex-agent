/**
 * LO QUE LA PERSONA LEE CUANDO UN PASO FALLA.
 *
 * El resultado de una herramienta que falló llega como `{ __error, tool, message }`
 * (a veces con el JSON del proveedor dentro). La persona ve UNA frase en español;
 * el JSON queda en un detalle plegado. Módulo puro, sin dependencias: lo usa un
 * componente de cliente (no importa el barril de agent-tools).
 */

const NOT_CONFIGURED =
  /not configured|missing\b|no est[aá] configurad|INTEGRATION_ERROR.*(config|missing)/i;

/** El mensaje crudo de un resultado con `__error`, o null si no lo es. */
export function rawToolError(result: unknown): string | null {
  if (!result || typeof result !== 'object' || !('__error' in result)) return null;
  const m = (result as { message?: unknown }).message;
  return typeof m === 'string' && m.trim() ? m.trim() : '';
}

/** Una frase corta y legible para el paso que falló. */
export function friendlyToolError(result: unknown): string {
  const raw = rawToolError(result);
  if (raw === null) return '';
  if (/no est[aá] (prendido|activo)|m[oó]dulo .* apagado/i.test(raw)) return raw.slice(0, 200);
  if (NOT_CONFIGURED.test(raw))
    return 'Este paso depende de un servicio que todavía no está conectado en esta empresa.';
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|permission/i.test(raw))
    return 'No tengo permiso para hacer este paso. Revisa que la conexión siga vigente.';
  if (/\b429\b|rate.?limit/i.test(raw))
    return 'El servicio pidió esperar un momento. Vuelve a intentar en unos minutos.';
  if (/timeout|timed out|ETIMEDOUT|aborted/i.test(raw))
    return 'El servicio no contestó a tiempo. Vuelve a intentar en unos minutos.';
  // Un mensaje ya escrito en español y corto se deja; el resto es técnico.
  if (
    raw.length <= 200 &&
    !/[{}\[\]]/.test(raw) &&
    /[áéíóúñ¿¡]|\b(no|el|la|de|que|se)\b/i.test(raw)
  )
    return raw;
  return 'Este paso no se pudo completar.';
}
