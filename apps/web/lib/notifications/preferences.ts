import 'server-only';
import type { NotificationKind } from '@/lib/notifications-shape';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type ChannelFlags,
  DEFAULT_CHANNELS,
  DEFAULT_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  type NotificationPreferences,
  anyChannelChosen,
  isHHMM,
  parsePreferences,
  resolveChannels,
} from './preferences-shape';

/**
 * PREFERENCIAS DE AVISOS: LEER Y GUARDAR (0223).
 *
 * LEER FALLA ABIERTO. Si la base no contesta (o la migración aún no corrió), se
 * devuelve el defecto —el comportamiento de siempre— y se registra. Un fallo
 * aquí no puede callar avisos que la persona sí quiere; lo peor que pasa es que
 * se ignora una preferencia hasta la próxima lectura.
 */

const COLUMNS = 'user_id, channels, quiet_enabled, quiet_start, quiet_end';

interface Row {
  user_id: string;
  channels: unknown;
  quiet_enabled: unknown;
  quiet_start: unknown;
  quiet_end: unknown;
}

/** Las preferencias de varias personas de una vez. Quien no tenga fila no sale en el mapa. */
export async function loadPreferences(
  db: SupabaseClient,
  userIds: string[],
): Promise<Map<string, NotificationPreferences>> {
  const out = new Map<string, NotificationPreferences>();
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return out;
  try {
    const { data, error } = await db
      .from('notification_preferences')
      .select(COLUMNS)
      .in('user_id', ids);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as Row[]) out.set(row.user_id, parsePreferences(row));
  } catch (err) {
    logger.warn(
      `notifications: no se pudieron leer las preferencias, se usan las de siempre — ${(err as Error).message}`,
    );
  }
  return out;
}

export async function loadPreferencesFor(
  db: SupabaseClient,
  userId: string,
): Promise<NotificationPreferences> {
  return (await loadPreferences(db, [userId])).get(userId) ?? DEFAULT_PREFERENCES;
}

/** Por qué canales puede salir un aviso de esta clase para esta persona, ahora. */
export async function channelsFor(
  db: SupabaseClient,
  userId: string,
  kind: NotificationKind,
  now: Date = new Date(),
): Promise<ChannelFlags> {
  return resolveChannels(await loadPreferencesFor(db, userId), kind, now);
}

/** «Tu día» apagado del todo: no se arma ni se manda. */
export function briefingOff(prefs: NotificationPreferences | undefined): boolean {
  return !anyChannelChosen(prefs, 'briefing');
}

/** Valida lo que llega de la pantalla; lo desconocido se descarta. */
export function sanitizePreferencesInput(input: unknown): NotificationPreferences | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as {
    channels?: unknown;
    quiet?: { enabled?: unknown; start?: unknown; end?: unknown };
  };
  const parsed = parsePreferences({
    channels: raw.channels,
    quiet_enabled: raw.quiet?.enabled,
    quiet_start: raw.quiet?.start,
    quiet_end: raw.quiet?.end,
  });
  if (raw.quiet && (!isHHMM(raw.quiet.start) || !isHHMM(raw.quiet.end))) return null;
  return parsed;
}

/** Guarda las de esta persona (el handle es del espacio; una fila por persona). */
export async function savePreferences(
  db: SupabaseClient,
  userId: string,
  prefs: NotificationPreferences,
): Promise<void> {
  // Sólo las diferencias con el defecto: así un defecto que cambie mañana les llega a todos.
  const channels: Record<string, Record<string, boolean>> = {};
  for (const category of NOTIFICATION_CATEGORIES) {
    const flags = prefs.channels[category];
    if (!flags) continue;
    const kept: Record<string, boolean> = {};
    for (const channel of NOTIFICATION_CHANNELS) {
      const v = flags[channel];
      if (typeof v === 'boolean' && v !== DEFAULT_CHANNELS[channel]) kept[channel] = v;
    }
    if (Object.keys(kept).length) channels[category] = kept;
  }
  const { error } = await db.from('notification_preferences').upsert(
    {
      user_id: userId,
      channels,
      quiet_enabled: prefs.quiet.enabled,
      quiet_start: prefs.quiet.start,
      quiet_end: prefs.quiet.end,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'organization_id,user_id' },
  );
  if (error) throw new Error(`No se pudieron guardar tus avisos: ${error.message}`);
}

/**
 * De estas personas, quiénes pueden recibir un CORREO de esta clase ahora
 * mismo (correo encendido y fuera de horas de silencio). Para los envíos que
 * van a varias personas: se les quita el correo a quien lo apagó, no al resto.
 */
export async function emailAllowedUsers(
  db: SupabaseClient,
  userIds: string[],
  kind: NotificationKind,
  now: Date = new Date(),
): Promise<Set<string>> {
  const prefs = await loadPreferences(db, userIds);
  return new Set(userIds.filter((id) => resolveChannels(prefs.get(id), kind, now).email));
}
