import type { SupabaseClient } from '@supabase/supabase-js';
import { getTrackerBySlug, upsertRow } from '../../trackers/store';
import { parseLocation } from '../../trackers/schema';
import { type Geofence, zoneOf } from '../geofence';
import type { AutomationEvent, Values } from './match';
import type { AutomationAction } from './spec';

/**
 * «MARCAR LA ZONA» (check_zone) Y «SÓLO LOS DE TURNO» (onShift), LADO SERVIDOR.
 *
 * Marcar no bloquea: si la persona está fuera de las zonas, el registro se hace
 * igual y queda marcado (`outsideValue`) para que las acciones siguientes avisen al
 * supervisor. Sin posición reciente la marca es «Sin señal», que no es lo mismo que
 * «fuera»: un GPS apagado no acusa a nadie.
 */

type CheckZone = Extract<AutomationAction, { type: 'check_zone' }>;

export interface ZoneOutcome {
  patch: Record<string, string>;
  status: 'inside' | 'outside' | 'unknown';
  zoneName: string | null;
}

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number | null;
}

/** La decisión pura: posición + lugares → qué se escribe. */
export function decideZone(
  action: CheckZone,
  places: readonly Geofence[],
  fix: Fix | null,
): ZoneOutcome {
  const patch: Record<string, string> = {};
  const finish = (status: ZoneOutcome['status'], zoneName: string | null): ZoneOutcome => {
    if (action.zoneField)
      patch[action.zoneField] = zoneName ?? (status === 'unknown' ? 'Sin ubicación' : 'Fuera de zona');
    if (action.outsideField)
      patch[action.outsideField] =
        status === 'inside'
          ? action.insideValue
          : status === 'outside'
            ? action.outsideValue
            : action.unknownValue;
    return { patch, status, zoneName };
  };
  if (!fix) return finish('unknown', null);
  if (action.locationField) patch[action.locationField] = `${fix.lat},${fix.lng}`;
  const verdict = zoneOf(places, fix, action.zones);
  if (verdict.place) return finish('inside', verdict.place.name);
  return verdict.uncertain ? finish('unknown', null) : finish('outside', null);
}

/** La posición en vivo de quien disparó el suceso, si es reciente. */
export async function livePositionOf(
  db: SupabaseClient,
  appId: string,
  actor: AutomationEvent['actor'] | undefined,
  maxAgeMinutes: number,
  now: Date,
): Promise<Fix | null> {
  if (!actor?.id) return null;
  const kind = actor.kind === 'app_user' ? 'app_user' : 'member';
  const { data, error } = await db
    .from('custom_app_locations')
    .select('lat, lng, accuracy_m, recorded_at')
    .eq('app_id', appId)
    .eq('subject_kind', kind)
    .eq('subject_id', actor.id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as { lat: number; lng: number; accuracy_m: number | null; recorded_at: string };
  if (now.getTime() - Date.parse(row.recorded_at) > maxAgeMinutes * 60_000) return null;
  return { lat: Number(row.lat), lng: Number(row.lng), accuracyM: row.accuracy_m };
}

/** Ejecuta la acción: lee la posición, decide y escribe en la fila que despertó la regla. */
export async function runCheckZone(input: {
  db: SupabaseClient;
  appId: string;
  places: readonly Geofence[];
  action: CheckZone;
  event: AutomationEvent;
  trackerSlug: string;
  currentValues: Values;
  userId: string | null;
  now: Date;
}): Promise<{ detail: string; patch: Record<string, string> }> {
  const { db, action, event } = input;
  if (!event.rowId) throw new Error('Sin fila donde marcar la zona.');
  if (!input.places.length) throw new Error('La app no tiene lugares (geocercas) definidos.');
  let fix: Fix | null;
  if (action.from) {
    const loc = parseLocation(String(input.currentValues[action.from] ?? ''));
    fix = loc ? { lat: loc.lat, lng: loc.lng, accuracyM: null } : null;
  } else {
    fix = await livePositionOf(db, input.appId, event.actor, action.maxAgeMinutes, input.now);
  }
  const out = decideZone(action, input.places, fix);
  const tracker = await getTrackerBySlug(db, input.trackerSlug);
  if (!tracker) throw new Error(`La tabla «${input.trackerSlug}» ya no existe.`);
  const changed = Object.entries(out.patch).filter(
    ([k, v]) => String(input.currentValues[k] ?? '') !== v,
  );
  if (changed.length)
    await upsertRow(db, {
      tracker,
      rowId: event.rowId,
      values: { ...input.currentValues, ...out.patch },
      userId: input.userId,
      only: new Set(changed.map(([k]) => k)),
      lenient: true,
    });
  const text =
    out.status === 'inside'
      ? `En zona: ${out.zoneName}.`
      : out.status === 'outside'
        ? 'FUERA de zona.'
        : 'Sin ubicación reciente.';
  return { detail: text, patch: out.patch };
}

/** De estos ids, los que tienen el turno abierto ahora en la app. */
export async function onShiftOnly(
  db: SupabaseClient,
  appId: string,
  kind: 'member' | 'app_user',
  ids: readonly string[],
): Promise<string[]> {
  if (!ids.length) return [];
  const { data, error } = await db
    .from('custom_app_location_consents')
    .select('subject_id')
    .eq('app_id', appId)
    .eq('subject_kind', kind)
    .eq('on_shift', true)
    .is('revoked_at', null)
    .in('subject_id', [...ids]);
  if (error) throw error;
  return ((data ?? []) as Array<{ subject_id: string }>).map((r) => r.subject_id);
}
