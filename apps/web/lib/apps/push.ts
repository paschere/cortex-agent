import 'server-only';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import webpush from 'web-push';

/**
 * NOTIFICACIONES PUSH (Web Push con VAPID) de las aplicaciones (migración 0210).
 *
 * Variables de entorno (las tres, o el push queda APAGADO y los avisos van por
 * correo; la pantalla lo dice en vez de prometer algo que no ocurre):
 *   VAPID_PUBLIC_KEY   clave pública (la ve el navegador para suscribirse)
 *   VAPID_PRIVATE_KEY  clave privada (sólo el servidor)
 *   VAPID_SUBJECT      `mailto:alguien@empresa.com` o una https de contacto
 * Se generan una vez con `npx web-push generate-vapid-keys`.
 *
 * Una suscripción pertenece a UN usuario (de app o miembro) en UN navegador, y
 * su `endpoint` es único: si otra persona entra en el mismo teléfono y activa
 * los avisos, la suscripción CAMBIA de dueño (un teléfono compartido no recibe
 * los avisos de quien salió). Una suscripción vencida (404/410) se borra al
 * primer intento de envío.
 */

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function vapidConfig(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const publicKey = (env.VAPID_PUBLIC_KEY ?? '').trim();
  const privateKey = (env.VAPID_PRIVATE_KEY ?? '').trim();
  const subject = (env.VAPID_SUBJECT ?? '').trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

export function pushEnabled(): boolean {
  return vapidConfig() !== null;
}

export interface PushPayload {
  title: string;
  body?: string;
  /** Ruta interna que abre el aviso (siempre dentro de /a/<app>/). */
  url: string;
  tag: string;
}

export interface StoredSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSender = (
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  body: string,
  vapid: VapidConfig,
) => Promise<void>;

export const realSender: PushSender = async (sub, body, vapid) => {
  await webpush.sendNotification(sub, body, {
    vapidDetails: {
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
    TTL: 60 * 60,
    urgency: 'high',
    timeout: 8000,
  });
};

/** Una ruta interna o nada: un aviso nunca abre otro sitio. */
export function safePushUrl(url: string, appId: string): string {
  const base = `/a/${appId}`;
  return url.startsWith(base) && !url.startsWith('//') ? url.slice(0, 300) : base;
}

/**
 * Manda a cada suscripción. Devuelve los ids de las que SÍ recibieron y borra
 * las vencidas. Sin llaves VAPID no manda nada (devuelve vacío: el llamador
 * cae al correo).
 */
export async function deliverPush(
  db: SupabaseClient,
  subs: Array<StoredSubscription & { owner: string }>,
  payload: PushPayload,
  appId: string,
  send: PushSender = realSender,
  vapid: VapidConfig | null = vapidConfig(),
): Promise<Set<string>> {
  const delivered = new Set<string>();
  if (!vapid || !subs.length) return delivered;
  const body = JSON.stringify({ ...payload, url: safePushUrl(payload.url, appId) });
  const expired: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, vapid);
        delivered.add(s.owner);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) expired.push(s.id);
        else logger.warn({ err, status }, 'web push failed');
      }
    }),
  );
  if (expired.length) await db.from('push_subscriptions').delete().in('id', expired);
  if (delivered.size) {
    await db
      .from('push_subscriptions')
      .update({ last_used_at: new Date().toISOString() })
      .in(
        'id',
        subs.filter((s) => delivered.has(s.owner)).map((s) => s.id),
      );
  }
  return delivered;
}

/** Push a usuarios externos de UNA app. Devuelve los usuarios a quienes les llegó. */
export async function pushToAppUsers(
  db: SupabaseClient,
  appId: string,
  userIds: string[],
  payload: PushPayload,
  send?: PushSender,
  vapid?: VapidConfig | null,
): Promise<string[]> {
  if (!userIds.length || !(vapid === undefined ? pushEnabled() : vapid)) return [];
  // SIEMPRE por app_id: una suscripción de otra app no recibe avisos de ésta.
  const { data, error } = await db
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, app_user_id')
    .eq('app_id', appId)
    .eq('subject_kind', 'app_user')
    .in('app_user_id', userIds);
  if (error) throw error;
  const subs = ((data ?? []) as Array<StoredSubscription & { app_user_id: string }>).map((s) => ({
    ...s,
    owner: s.app_user_id,
  }));
  return [
    ...(await deliverPush(db, subs, payload, appId, send, vapid === undefined ? undefined : vapid)),
  ];
}

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function validSubscription(raw: unknown): SubscriptionInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof r.endpoint !== 'string' || !/^https:\/\/[^\s]{10,1900}$/.test(r.endpoint)) return null;
  if (typeof r.keys?.p256dh !== 'string' || typeof r.keys?.auth !== 'string') return null;
  if (r.keys.p256dh.length > 200 || r.keys.auth.length > 100) return null;
  return { endpoint: r.endpoint, keys: { p256dh: r.keys.p256dh, auth: r.keys.auth } };
}

/** Guarda (o cambia de dueño) la suscripción de este navegador. */
export async function saveSubscription(
  db: SupabaseClient,
  input: {
    appId: string;
    subject: { kind: 'app_user'; appUserId: string } | { kind: 'member'; memberId: string };
    subscription: SubscriptionInput;
    userAgent: string;
  },
): Promise<void> {
  const { error } = await db.from('push_subscriptions').upsert(
    {
      app_id: input.appId,
      subject_kind: input.subject.kind,
      member_id: input.subject.kind === 'member' ? input.subject.memberId : null,
      app_user_id: input.subject.kind === 'app_user' ? input.subject.appUserId : null,
      endpoint: input.subscription.endpoint,
      p256dh: input.subscription.keys.p256dh,
      auth: input.subscription.keys.auth,
      user_agent: input.userAgent.slice(0, 300),
    },
    { onConflict: 'endpoint' },
  );
  if (error) throw error;
}

export async function removeSubscription(db: SupabaseClient, endpoint: string): Promise<void> {
  await db.from('push_subscriptions').delete().eq('endpoint', endpoint);
}

/** Push a miembros de Cortex que activaron los avisos en ESTA app. */
export async function pushToMembers(
  db: SupabaseClient,
  appId: string,
  memberIds: string[],
  payload: PushPayload,
  send?: PushSender,
  vapid?: VapidConfig | null,
): Promise<string[]> {
  if (!memberIds.length || !(vapid === undefined ? pushEnabled() : vapid)) return [];
  const { data, error } = await db
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, member_id')
    .eq('app_id', appId)
    .eq('subject_kind', 'member')
    .in('member_id', memberIds);
  if (error) throw error;
  const subs = ((data ?? []) as Array<StoredSubscription & { member_id: string }>).map((s) => ({
    ...s,
    owner: s.member_id,
  }));
  return [
    ...(await deliverPush(db, subs, payload, appId, send, vapid === undefined ? undefined : vapid)),
  ];
}
