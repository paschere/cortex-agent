import type { SupabaseClient } from '@supabase/supabase-js';
import { orgAdmins } from '../directory/store';
import {
  type Geofence,
  type GeofenceHit,
  type Transition,
  evaluateGeofences,
  geofenceMessage,
} from './geofence';
import type { PersonKind } from './location-shape';
import type { AppAccess } from './store';

/**
 * GEOCERCAS, LADO SERVIDOR (migración 0224).
 *
 * Se evalúa en la propia posición (`recordPosition` la llama al guardar una
 * muestra): ahí ya están las cuatro puertas cerradas (app encendida, rol,
 * consentimiento, turno), así que no hay forma de evaluar a alguien que no
 * comparte. Es barato: una lectura de las filas de la persona y, sólo si cruzó
 * un borde, una escritura por cruce.
 *
 * Un cruce se «reclama» antes de avisar: el cambio de estado va condicionado al
 * estado anterior (`eq('inside', antes)`), así que dos posiciones simultáneas
 * (o un reintento) dejan UN solo «llegó» y UN solo aviso.
 */

export interface GeofenceNotifier {
  notifyMembers(
    db: SupabaseClient,
    userIds: string[],
    note: { appId: string; title: string; body?: string; href: string; dedupeKey: string },
  ): Promise<number>;
  pushAppUsers?(
    db: SupabaseClient,
    appId: string,
    userIds: string[],
    payload: { title: string; body?: string; url: string; tag: string },
  ): Promise<string[]>;
}

export interface GeofenceEvent {
  id: string;
  geofenceId: string;
  name: string;
  kind: Transition;
  at: string;
}

interface StateRow {
  id: string;
  geofence_id: string;
  inside: boolean;
}

const PG_UNIQUE = '23505';

function actorOf(access: AppAccess): { kind: PersonKind; id: string } {
  return access.user.external
    ? { kind: 'app_user', id: access.user.id }
    : { kind: 'member', id: access.user.id };
}

/** Evalúa la posición de quien la envía contra los lugares de la app y registra los cruces. */
export async function applyGeofences(
  db: SupabaseClient,
  access: AppAccess,
  fix: { lat: number; lng: number; accuracyM: number | null },
  notifier?: GeofenceNotifier,
  now: Date = new Date(),
): Promise<GeofenceEvent[]> {
  const places = access.app.location.geofences;
  if (!places.length) return [];
  const actor = actorOf(access);
  const appId = access.app.id;
  const { data, error } = await db
    .from('custom_app_geofence_state')
    .select('id, geofence_id, inside')
    .eq('app_id', appId)
    .eq('subject_kind', actor.kind)
    .eq('subject_id', actor.id)
    .limit(100);
  if (error) throw error;
  const rows = new Map(((data ?? []) as StateRow[]).map((r) => [r.geofence_id, r]));
  const states = new Map([...rows].map(([id, r]) => [id, r.inside]));
  const { next, crossings, hits } = evaluateGeofences(places, states, fix);
  const iso = now.toISOString();
  const won = new Set<string>();

  for (const place of places) {
    const prev = rows.get(place.id);
    const inside = next.get(place.id) ?? false;
    if (prev && prev.inside === inside) continue;
    const isCrossing = crossings.some((c) => c.place.id === place.id);
    if (prev) {
      const { data: updated, error: err } = await db
        .from('custom_app_geofence_state')
        .update({ inside, since: iso, updated_at: iso })
        .eq('id', prev.id)
        .eq('inside', prev.inside)
        .select('id');
      if (err) throw err;
      if (updated?.length && isCrossing) won.add(place.id);
    } else {
      const { error: err } = await db.from('custom_app_geofence_state').insert({
        organization_id: access.app.organization_id,
        app_id: appId,
        geofence_id: place.id,
        subject_kind: actor.kind,
        subject_id: actor.id,
        inside,
        since: iso,
      });
      if (err) {
        if ((err as { code?: string }).code === PG_UNIQUE) continue;
        throw err;
      }
      if (isCrossing) won.add(place.id);
    }
  }

  const events: GeofenceEvent[] = [];
  for (const hit of hits) {
    if (!won.has(hit.place.id)) continue;
    const { data: row, error: err } = await db
      .from('custom_app_geofence_events')
      .insert({
        organization_id: access.app.organization_id,
        app_id: appId,
        geofence_id: hit.place.id,
        geofence_name: hit.place.name,
        subject_kind: actor.kind,
        subject_id: actor.id,
        subject_name: (access.user.name || 'Alguien').slice(0, 120),
        kind: hit.transition,
        at: iso,
      })
      .select('id')
      .single();
    if (err) throw err;
    const event: GeofenceEvent = {
      id: (row as { id: string }).id,
      geofenceId: hit.place.id,
      name: hit.place.name,
      kind: hit.transition,
      at: iso,
    };
    events.push(event);
    if (notifier) await notifyHit(db, access, hit, event, notifier).catch(() => undefined);
  }
  return events;
}

async function notifyHit(
  db: SupabaseClient,
  access: AppAccess,
  hit: GeofenceHit,
  event: GeofenceEvent,
  notifier: GeofenceNotifier,
): Promise<void> {
  const { roles, admins } = hit.place.notify;
  if (!roles.length && !admins) return;
  const appId = access.app.id;
  const title = geofenceMessage(hit.place, hit.transition, access.user.name || 'Alguien');
  const memberIds = new Set<string>();
  if (roles.length) {
    const { data } = await db
      .from('custom_app_members')
      .select('user_id')
      .eq('app_id', appId)
      .in('role_key', roles);
    for (const m of (data ?? []) as Array<{ user_id: string }>) memberIds.add(m.user_id);
  }
  if (admins) for (const id of await orgAdmins(db, 20)) memberIds.add(id);
  // A quien cruzó no se le avisa de sí mismo.
  if (!access.user.external) memberIds.delete(access.user.id);
  if (memberIds.size)
    await notifier.notifyMembers(db, [...memberIds], {
      appId,
      title,
      href: `/apps/${access.app.slug}`,
      dedupeKey: `geofence:${event.id}`,
    });
  if (roles.length && notifier.pushAppUsers) {
    const { data } = await db
      .from('custom_app_users')
      .select('id')
      .eq('app_id', appId)
      .neq('status', 'disabled')
      .in('role_key', roles)
      .limit(200);
    const ids = ((data ?? []) as Array<{ id: string }>)
      .map((u) => u.id)
      .filter((id) => !(access.user.external && id === access.user.id));
    if (ids.length)
      await notifier.pushAppUsers(db, appId, ids, {
        title,
        url: `/a/${appId}`,
        tag: `geofence:${hit.place.id}`,
      });
  }
}

export interface GeofenceFeedItem {
  id: string;
  geofenceId: string;
  name: string;
  person: string;
  kind: Transition;
  at: string;
}

/** Los últimos cruces de la app (para quien ve la ubicación del equipo). */
export async function recentGeofenceEvents(
  db: SupabaseClient,
  appId: string,
  limit = 30,
): Promise<GeofenceFeedItem[]> {
  const { data, error } = await db
    .from('custom_app_geofence_events')
    .select('id, geofence_id, geofence_name, subject_name, kind, at')
    .eq('app_id', appId)
    .order('at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, string>>).map((r) => ({
    id: r.id as string,
    geofenceId: r.geofence_id as string,
    name: r.geofence_name as string,
    person: r.subject_name as string,
    kind: r.kind as Transition,
    at: r.at as string,
  }));
}

/** Quién está adentro de cada lugar ahora (lugar → nombres), sólo de personas con turno abierto. */
export async function insideNow(
  db: SupabaseClient,
  appId: string,
): Promise<Array<{ geofenceId: string; kind: PersonKind; id: string; since: string }>> {
  const { data, error } = await db
    .from('custom_app_geofence_state')
    .select('geofence_id, subject_kind, subject_id, since')
    .eq('app_id', appId)
    .eq('inside', true)
    .limit(1000);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, string>>).map((r) => ({
    geofenceId: r.geofence_id as string,
    kind: r.subject_kind as PersonKind,
    id: r.subject_id as string,
    since: r.since as string,
  }));
}

/** Borra el estado de una persona (turno terminado, revocación, baja) — sin avisar nada. */
export async function clearGeofenceState(
  db: SupabaseClient,
  appId: string,
  kind: PersonKind,
  id: string,
): Promise<void> {
  try {
    await db
      .from('custom_app_geofence_state')
      .delete()
      .eq('app_id', appId)
      .eq('subject_kind', kind)
      .eq('subject_id', id);
  } catch {}
}

/** Al quitar un lugar de la lista, su estado ya no sirve. */
export async function pruneGeofenceState(
  db: SupabaseClient,
  appId: string,
  keep: readonly Pick<Geofence, 'id'>[],
): Promise<void> {
  try {
    const q = db.from('custom_app_geofence_state').delete().eq('app_id', appId);
    const ids = keep.map((g) => g.id);
    await (ids.length ? q.not('geofence_id', 'in', `(${ids.join(',')})`) : q);
  } catch {}
}
