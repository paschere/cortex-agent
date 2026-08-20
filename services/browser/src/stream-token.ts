import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * El boleto de corta vida que deja a UN navegador mirar UNA sesión.
 *
 * ===========================================================================
 * EL PROBLEMA QUE RESUELVE
 * ===========================================================================
 * La pantalla en vivo es un WebSocket, y Vercel no termina WebSockets: el
 * navegador de la persona tiene que conectarse DIRECTO a este servicio. Pero
 * la única credencial que este servicio conoce es `BROWSER_SERVICE_TOKEN`,
 * que vale todo lo que el servicio puede hacer y jamás puede pisar un
 * navegador (server.ts lo dice y lo dice en serio).
 *
 * Así que Cortex —que sí tiene el token de servicio y sí sabe quién está
 * logueado— pide aquí un boleto derivado: HMAC del par (sesión, vencimiento)
 * con el token de servicio como llave. El boleto:
 *
 *   * abre EXACTAMENTE una sesión — el id firmado es parte del mensaje,
 *   * durante un minuto — suficiente para un upgrade, inútil en un log de
 *     acceso de la semana pasada (y sí viaja en query string, porque un
 *     upgrade de WebSocket no lleva headers propios; el vencimiento corto es
 *     la respuesta honesta a ese pecado),
 *   * y no revela nada del token de servicio: HMAC no se invierte.
 *
 * No hay estado: verificar es recomputar. Un boleto no se puede revocar antes
 * de su minuto, y no hace falta — lo que protege ya expira solo.
 */

const TTL_MS = 60_000;

export function signStreamToken(sessionId: string, secret: string, now = Date.now()): string {
  const exp = now + TTL_MS;
  const sig = createHmac('sha256', secret).update(`${sessionId}.${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}

export function verifyStreamToken(
  token: string,
  sessionId: string,
  secret: string,
  now = Date.now(),
): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < now) return false;
  const presented = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(
    createHmac('sha256', secret).update(`${sessionId}.${exp}`).digest('base64url'),
  );
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}
