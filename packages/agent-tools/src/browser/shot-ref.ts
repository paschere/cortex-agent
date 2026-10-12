/**
 * La referencia a la foto chica de un paso.
 *
 * Los bytes se quedan en el servicio de navegador (services/browser/src/shots.ts)
 * y el resultado de la herramienta lleva SÓLO esta ruta de apps/web — unos 60
 * caracteres — por la misma razón por la que `download.ts` saca el archivo del
 * resultado: ni el contexto del modelo ni la fila de la base son sitio para
 * una imagen. La pantalla (`BrowserPanel`) la carga con la cookie de la
 * persona, y la ruta pregunta al servicio con el dueño de la pestaña.
 */

const SESSION_RE = /^[A-Za-z0-9_]{1,64}$/;
const SHOT_RE = /^[A-Za-z0-9_-]{6,32}$/;

/** `undefined` si falta algo o el id no tiene la forma esperada (nunca se arma una ruta a ciegas). */
export function shotUrl(
  sessionId: string | undefined | null,
  shotId: string | undefined | null,
): string | undefined {
  if (!sessionId || !shotId) return undefined;
  if (!SESSION_RE.test(sessionId) || !SHOT_RE.test(shotId)) return undefined;
  return `/api/browser/live/${sessionId}/shot/${shotId}`;
}
