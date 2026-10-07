/**
 * TOPES POR VENTANA, EN MEMORIA DEL PROCESO.
 *
 * Frenan el abuso de la pantalla de entrada (pedir códigos o adivinarlos desde
 * una misma IP) sin tabla nueva, igual que el tope de exportar
 * (lib/views/export-response.ts). En varias instancias cada una cuenta aparte:
 * es un freno barato, no una cuota exacta. Lo que sí es exacto y vive en la
 * base son los topes POR USUARIO: 5 códigos por hora y 5 intentos por código
 * (packages/agent-tools/src/apps/external.ts).
 */

export interface Limiter {
  /** True si esta llave aún puede; cuenta la llamada. */
  take(key: string, now?: number): boolean;
}

export function createLimiter(limit: number, windowMs: number): Limiter {
  const hits = new Map<string, number[]>();
  return {
    take(key, now = Date.now()) {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5000)
        for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      return true;
    },
  };
}

const HOUR = 3_600_000;
/** Pedir códigos: por IP y por correo (el correo cuenta aunque no exista, para no distinguir). */
export const codeRequestsByIp = createLimiter(20, HOUR);
export const codeRequestsByEmail = createLimiter(8, HOUR);
/** Probar códigos: por IP. El tope por código (5) está en la base. */
export const codeAttemptsByIp = createLimiter(40, HOUR);

/**
 * Topes de un usuario externo por hora (además de los de la pantalla y los de
 * los envíos en la base): subir archivos y dictar. Un miembro de Cortex no
 * entra aquí, tiene el tope del plan.
 */
export const uploadsByAppUser = createLimiter(120, HOUR);
export const dictationsByAppUser = createLimiter(80, HOUR);
/** Los turnos de voz son muchos por formulario (uno por campo): su tope es aparte y más ancho. */
export const voiceTurnsByAppUser = createLimiter(400, HOUR);

/**
 * PIN del modo kiosco (0211). El freno exacto es el bloqueo por persona en la
 * base (5 intentos); éste frena a quien prueba a muchas personas desde un mismo
 * dispositivo o una misma IP.
 */
export const pinAttemptsByDevice = createLimiter(40, 15 * 60_000);
export const pinAttemptsByIp = createLimiter(120, HOUR);
