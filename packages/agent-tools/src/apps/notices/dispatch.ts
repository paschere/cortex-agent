import type { SupabaseClient } from '@supabase/supabase-js';
import type { AutomationEvent } from '../automations/match';
import { type NoticeEvent, type NoticePerson, planNotices } from './plan';
import {
  type StoredNotice,
  loadNoticePeople,
  loadNoticePrefs,
  loadNoticeTracker,
  loadRowOwner,
  noticeModelsForTracker,
  storeNotices,
} from './store';
import { groupTitle } from './shape';
import { interestsFor } from './interest';

/**
 * DEL CAMBIO DE UNA FILA A LOS AVISOS (0231).
 *
 * `emit.ts` —el punto único por donde una escritura de fila se vuelve evento—
 * llama aquí con cada fila creada o cambiada. Esto NO crea reglas ni encola
 * nada: calcula quién depende de esa tabla (planificador puro), guarda los
 * avisos en la bandeja de cada persona y, para lo que suena, los entrega por
 * push (si hay llaves VAPID y la persona aceptó), correo (asignar y aprobar, o
 * lo que la persona pidió) y campana (miembros de Cortex).
 *
 * La entrega la registra la app web (`setNoticeDelivery`, en
 * instrumentation-node.ts): este paquete no puede importar el correo ni el
 * push. Sin entrega registrada igual queda la bandeja y los contadores.
 * `dispatchRowNotices` nunca lanza: un aviso caído no puede tumbar el guardado
 * de la fila de un operario.
 */

export interface NoticePushPayload {
  title: string;
  body?: string;
  url: string;
  tag: string;
}

export interface NoticeDelivery {
  pushEnabled(): boolean;
  pushAppUsers(
    db: SupabaseClient,
    appId: string,
    userIds: string[],
    payload: NoticePushPayload,
  ): Promise<string[]>;
  pushMembers(
    db: SupabaseClient,
    appId: string,
    userIds: string[],
    payload: NoticePushPayload,
  ): Promise<string[]>;
  bell(
    db: SupabaseClient,
    note: {
      userId: string;
      title: string;
      body: string;
      href: string;
      dedupeKey: string;
      groupKey: string;
    },
  ): Promise<string | null>;
  email(msg: { to: string; subject: string; text: string }): Promise<{ sent: boolean }>;
  baseUrl(): string;
}

// En `globalThis` por la misma razón que los enganches de emit.ts: la entrega
// se registra en `instrumentation` y la usan las rutas, que pueden tener otra
// copia de este módulo.
const DELIVERY_KEY = Symbol.for('cortex.notices.delivery');
function currentDelivery(): NoticeDelivery | null {
  return (globalThis as unknown as Record<symbol, NoticeDelivery | null | undefined>)[DELIVERY_KEY] ?? null;
}
export function setNoticeDelivery(d: NoticeDelivery | null): void {
  (globalThis as unknown as Record<symbol, NoticeDelivery | null>)[DELIVERY_KEY] = d;
}

/** Cómo llegó un aviso a una persona (para el resultado de la entrega y las pruebas). */
export type NoticeChannel = 'push' | 'email' | 'bell' | 'inbox';

export interface DeliveryApp {
  id: string;
  slug: string;
  name: string;
}

/**
 * Entrega lo que suena. Una persona silenciada, o un aviso que la ráfaga ya
 * resumió, queda sólo en la bandeja. Asignar y aprobar (siempre uno por uno)
 * caen al correo si el push no llegó; los demás sólo si la persona pidió correo.
 */
export async function deliverStored(
  db: SupabaseClient,
  app: DeliveryApp,
  stored: readonly StoredNotice[],
  d: NoticeDelivery | null = currentDelivery(),
): Promise<Map<string, NoticeChannel>> {
  const result = new Map<string, NoticeChannel>();
  if (!d) return result;
  for (const s of stored) {
    result.set(s.id, 'inbox');
    if (s.muted || s.mode === 'silent') continue;
    const p = s.planned;
    const summary = s.mode === 'summary';
    const rowParam = !summary && p.rowId ? `?fila=${encodeURIComponent(p.rowId)}` : '';
    const path = `/a/${app.id}${p.screen ? `/${p.screen}` : ''}`;
    const title = summary ? groupTitle(p.kind, 4, p.trackerName).replace(/^4 /, 'Varios ') : p.title;
    const body = summary ? 'Llegaron varios seguidos. Ábrelos en la app.' : p.body;
    const payload: NoticePushPayload = {
      title: title.slice(0, 120),
      body,
      url: `${path}${rowParam}`,
      // Mismo tag para los del mismo grupo: el sistema los junta en una sola notificación.
      tag: p.kind === 'assigned' || p.kind === 'approval' ? `notice:${p.dedupeKey.slice(-80)}` : `notice:${p.kind}:${p.trackerId}`,
    };
    try {
      let channel: NoticeChannel = 'inbox';
      if (p.person.kind === 'app_user') {
        const pushed = await d
          .pushAppUsers(db, app.id, [p.person.id], payload)
          .catch(() => [] as string[]);
        if (pushed.includes(p.person.id)) channel = 'push';
        else if (
          p.person.email &&
          (p.kind === 'assigned' || p.kind === 'approval' || s.prefs.email)
        ) {
          const out = await d.email({
            to: p.person.email,
            subject: title.slice(0, 120),
            text: `${body}\n\nÁbrelo aquí: ${d.baseUrl()}${path}${rowParam}\n\nAviso de «${app.name}». Puedes elegir qué avisos recibir desde la campana de la app.`,
          });
          if (out.sent) channel = 'email';
        }
      } else {
        const important = p.kind === 'assigned' || p.kind === 'approval';
        if (important) {
          const id = await d.bell(db, {
            userId: p.person.id,
            title: title.slice(0, 120),
            body,
            href: `/apps/${app.slug}${p.screen ? `/${p.screen}` : ''}${rowParam}`,
            dedupeKey: `appnotice:${s.id}`,
            groupKey: `appauto:${app.id}`,
          });
          if (id) channel = 'bell';
        }
        const pushed = await d
          .pushMembers(db, app.id, [p.person.id], payload)
          .catch(() => [] as string[]);
        if (pushed.includes(p.person.id)) channel = 'push';
        else if (channel === 'inbox' && p.person.email && s.prefs.email) {
          const out = await d.email({
            to: p.person.email,
            subject: title.slice(0, 120),
            text: `${body}\n\nÁbrelo aquí: ${d.baseUrl()}${path}${rowParam}\n\nAviso de «${app.name}».`,
          });
          if (out.sent) channel = 'email';
        }
      }
      result.set(s.id, channel);
    } catch {
      // Un canal caído deja el aviso en la bandeja.
    }
  }
  return result;
}

export interface DispatchDeps {
  now?: () => number;
  delivery?: NoticeDelivery | null;
}

const WATCH_TTL_MS = 30_000;
const watchCache = new Map<string, { at: number; value: boolean }>();
export function forgetNoticeWatch(): void {
  watchCache.clear();
}

/**
 * ¿Alguna app publicada depende de esta tabla? Una consulta recordada 30 s: es
 * lo que decide si `emit.ts` hace algo más por esta escritura.
 */
export async function watchesForNotices(
  db: SupabaseClient,
  trackerId: string,
  now = Date.now(),
): Promise<boolean> {
  const hit = watchCache.get(trackerId);
  if (hit && now - hit.at < WATCH_TTL_MS) return hit.value;
  let value = false;
  try {
    const tracker = await loadNoticeTracker(db, trackerId, now);
    if (tracker) {
      const models = await noticeModelsForTracker(db, tracker, now);
      value = models.some((m) => interestsFor(m, tracker.slug).length > 0);
    }
  } catch {
    value = false;
  }
  watchCache.set(trackerId, { at: now, value });
  return value;
}

/** El suceso de una fila → avisos guardados y entregados. Devuelve cuántos avisos nuevos quedaron. */
export async function dispatchRowNotices(
  db: SupabaseClient,
  event: AutomationEvent,
  deps: DispatchDeps = {},
): Promise<number> {
  try {
    if (event.kind !== 'row_created' && event.kind !== 'row_updated') return 0;
    if (!event.trackerId || !event.rowId || !event.after) return 0;
    const now = deps.now?.() ?? Date.now();
    const tracker = await loadNoticeTracker(db, event.trackerId, now);
    if (!tracker) return 0;
    const models = (await noticeModelsForTracker(db, tracker, now)).filter(
      (m) => interestsFor(m, tracker.slug).length > 0,
    );
    if (!models.length) return 0;
    const row = await loadRowOwner(db, event.rowId);
    let total = 0;
    for (const app of models) {
      const [people, prefs] = await Promise.all([
        loadNoticePeople(db, app.id),
        loadNoticePrefs(db, app.id),
      ]);
      const actor = actorOf(event, people);
      const planned = planNotices({
        app,
        tracker,
        event: {
          kind: event.kind,
          rowId: event.rowId,
          before: event.before ?? null,
          after: event.after,
          label: event.label ?? '',
          version: event.version,
          actor,
          actorName: actor.id
            ? people.find((p) => p.kind === actor.kind && p.id === actor.id)?.name
            : undefined,
        } satisfies NoticeEvent,
        row,
        people,
        prefs,
      });
      if (!planned.length) continue;
      const stored = await storeNotices(db, app.id, planned, prefs, now);
      total += stored.length;
      await deliverStored(db, app, stored, deps.delivery === undefined ? currentDelivery() : deps.delivery);
    }
    return total;
  } catch {
    return 0;
  }
}

function actorOf(event: AutomationEvent, _people: readonly NoticePerson[]): NoticeEvent['actor'] {
  return { kind: event.actor.kind, id: event.actor.id ?? null };
}

/** Lo que `emit.ts` guarda: mira si hay apps que dependen de la tabla y avisa. */
export const rowNoticeListener = {
  watches: (db: SupabaseClient, trackerId: string) => watchesForNotices(db, trackerId),
  onEvent: async (db: SupabaseClient, event: AutomationEvent): Promise<void> => {
    await dispatchRowNotices(db, event);
  },
};
