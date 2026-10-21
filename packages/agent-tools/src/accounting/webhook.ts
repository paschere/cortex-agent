import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * AVISOS DE SIIGO (webhooks) DE PRODUCTOS Y EXISTENCIAS (0234).
 *
 * Siigo avisa cuando se crea o cambia un producto o se mueven sus existencias
 * (tópicos `public.siigoapi.products.create`, `…products.update` y
 * `…products.stock.update`), pero NO firma sus avisos: la única defensa es que
 * la dirección a la que avisa sea imposible de adivinar. Esa dirección lleva la
 * firma HMAC de «espacio + conexión» con un secreto del servidor, así que:
 *
 *   - quien no conozca el secreto no puede fabricar la dirección;
 *   - una dirección sirve sólo para ESA conexión;
 *   - el aviso no trae datos que se guarden: sólo despierta la sincronización
 *     de siempre, que lee de Siigo con la llave de la conexión.
 *
 * Puro salvo `process.env` para el secreto.
 */

export const SIIGO_WEBHOOK_TOPICS = [
  'public.siigoapi.products.create',
  'public.siigoapi.products.update',
  'public.siigoapi.products.stock.update',
] as const;

/** Entre un aviso y el siguiente que dispara una corrida (los movimientos de stock llegan a ráfagas). */
export const WEBHOOK_MIN_GAP_MS = 60_000;

function secretOf(env: Record<string, string | undefined> = process.env): string | null {
  const s = (env.ACCOUNTING_WEBHOOK_SECRET ?? env.TOKEN_ENCRYPTION_KEY ?? '').trim();
  return s.length >= 16 ? s : null;
}

/** La firma de la dirección de una conexión; `null` si el servidor no tiene secreto. */
export function siigoWebhookSignature(
  organizationId: string,
  connectionId: string,
  env?: Record<string, string | undefined>,
): string | null {
  const secret = secretOf(env);
  if (!secret) return null;
  return createHmac('sha256', secret)
    .update(`siigo-webhook:${organizationId}:${connectionId}`)
    .digest('hex')
    .slice(0, 40);
}

export function verifySiigoWebhook(
  organizationId: string,
  connectionId: string,
  signature: string,
  env?: Record<string, string | undefined>,
): boolean {
  const expected = siigoWebhookSignature(organizationId, connectionId, env);
  if (!expected || signature.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/** La dirección completa que se le da a Siigo, o `null` sin secreto. */
export function siigoWebhookUrl(
  baseUrl: string,
  organizationId: string,
  connectionId: string,
  env?: Record<string, string | undefined>,
): string | null {
  const sig = siigoWebhookSignature(organizationId, connectionId, env);
  if (!sig) return null;
  return `${baseUrl.replace(/\/+$/, '')}/api/webhooks/siigo/${encodeURIComponent(organizationId)}/${connectionId}/${sig}`;
}

/**
 * ¿Corre la sincronización ya o se deja para el próximo barrido? Una corrida
 * por minuto como mucho; el resto se anota (`next_run_at` ahora) y el barrido
 * de cada 15 minutos lo recoge.
 */
export function webhookShouldRunNow(lastRunAt: string | null, now: Date): boolean {
  if (!lastRunAt) return true;
  return now.getTime() - Date.parse(lastRunAt) >= WEBHOOK_MIN_GAP_MS;
}
