import 'server-only';
import {
  type PushSender,
  type VapidConfig,
  pushEnabled,
  realSender,
  vapidConfig,
} from '@/lib/apps/push';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * WEB PUSH DE LA APP PRINCIPAL DE CORTEX (0220), sobre lo que ya hay de las
 * aplicaciones (0210): la misma tabla `push_subscriptions` (con `app_id` nulo y
 * `subject_kind = 'member'`), las mismas llaves VAPID y el mismo envío.
 *
 * Sin las tres variables VAPID no manda nada y devuelve vacío: el llamador ya
 * tiene la campana y el correo. Una suscripción vencida (404/410) se borra al
 * primer intento.
 *
 * `member_id` es el id de la persona en el directorio de la empresa
 * (`users.id`), el mismo que usa `notify()`.
 */

export interface MainPushPayload {
  title: string;
  body?: string;
  /** Ruta interna que abre el aviso. */
  url: string;
  tag: string;
}

/** Una ruta interna o la bandeja: un aviso nunca abre otro sitio. */
export function safeMainPushUrl(url: string): string {
  return url.startsWith('/') && !url.startsWith('//') ? url.slice(0, 300) : '/notifications';
}

/** Manda a las suscripciones de estas personas. Devuelve los ids de quienes lo recibieron. */
export async function pushToPeople(
  db: SupabaseClient,
  userIds: string[],
  payload: MainPushPayload,
  send: PushSender = realSender,
  vapid: VapidConfig | null = vapidConfig(),
): Promise<string[]> {
  if (!userIds.length || !vapid) return [];
  const { data, error } = await db
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, member_id')
    .eq('subject_kind', 'member')
    .is('app_id', null)
    .in('member_id', userIds);
  if (error) throw error;
  const subs = (data ?? []) as Array<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    member_id: string;
  }>;
  if (!subs.length) return [];
  const body = JSON.stringify({
    title: payload.title.slice(0, 120),
    body: payload.body?.slice(0, 240),
    url: safeMainPushUrl(payload.url),
    tag: payload.tag.slice(0, 80),
  });
  const delivered = new Set<string>();
  const expired: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, vapid);
        delivered.add(s.member_id);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) expired.push(s.id);
        else logger.warn({ err, status }, 'web push (main app) failed');
      }
    }),
  );
  if (expired.length) await db.from('push_subscriptions').delete().in('id', expired);
  return [...delivered];
}

export { pushEnabled };
