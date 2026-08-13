import 'server-only';
import {
  NOTIFICATION_KINDS,
  NOTIFICATION_TONES,
  type NotificationKind,
  type NotificationTone,
  type NotificationView,
} from '@/lib/notifications-shape';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Leer la bandeja, contar lo no leído, y marcar.
 *
 * ===========================================================================
 * LAS DOS POSTURAS ANTE UN FALLO DE BASE, Y POR QUÉ SON DISTINTAS
 * ===========================================================================
 * `listNotifications` REVIENTA si la base falla, y lo hace mirando el `error`
 * en vez de desestructurar `data` y quedarse tan tranquila. Es contenido: una
 * bandeja vacía y una bandeja rota se ven idénticas y significan lo contrario,
 * y quien mira necesita saber cuál de las dos es para poder reportarlo. En este
 * repositorio esa confusión exacta ya se vio en producción — todas las
 * conversaciones del producto leyéndose como recién creadas porque un `select`
 * nombró una columna antes de que aterrizara su migración.
 *
 * `countUnread` se traga su error y devuelve 0. Es la única excepción de este
 * módulo y es la misma que `lib/nav-signals.ts` argumenta: el contador vive en
 * la barra superior de TODAS las pantallas del producto. Un número que falta
 * cuesta un número; un número que lanza cuesta la navegación entera. El
 * contenido de la bandeja sigue fallando a gritos en su propia pantalla, que es
 * donde alguien puede hacer algo con el error.
 *
 * ===========================================================================
 * `user_id` EN TODAS LAS CLÁUSULAS, INCLUSO DONDE PARECE REDUNDANTE
 * ===========================================================================
 * El handle ya filtra por espacio de trabajo, así que sin `user_id` una llamada
 * a `markAllRead` marcaría lo de TODOS los compañeros de empresa, y un
 * `markRead` con un id ajeno marcaría el aviso de otra persona. El espacio de
 * trabajo es la frontera entre empresas; dentro de una empresa, la bandeja es
 * de quien es. Son dos cosas distintas y hacen falta las dos.
 */

const DEFAULT_LIMIT = 60;

interface Row {
  id: string;
  kind: string;
  tone: string;
  title: string;
  body: string | null;
  href: string | null;
  occurrences: number | null;
  occurred_at: string;
  read_at: string | null;
}

const KNOWN_KINDS = new Set<string>(NOTIFICATION_KINDS);
const KNOWN_TONES = new Set<string>(NOTIFICATION_TONES);

/**
 * Una fila cruda pasada a lo que la pantalla dibuja.
 *
 * Una clase o un tono que la pantalla no conoce no rompe la bandeja: se dibuja
 * en neutro. Eso pasa exactamente una vez, durante un despliegue en el que la
 * migración que amplía el CHECK ya está aplicada y el JavaScript viejo sigue
 * servido, y durante esos minutos es mucho mejor un aviso gris que una pantalla
 * caída.
 */
function toView(row: Row): NotificationView {
  return {
    id: row.id,
    kind: (KNOWN_KINDS.has(row.kind) ? row.kind : 'routine_finished') as NotificationKind,
    tone: (KNOWN_TONES.has(row.tone) ? row.tone : 'info') as NotificationTone,
    title: row.title,
    body: row.body,
    href: row.href,
    occurrences: row.occurrences ?? 1,
    occurredAt: row.occurred_at,
    readAt: row.read_at,
  };
}

/** La bandeja de una persona, lo más reciente primero. */
export async function listNotifications(
  db: SupabaseClient,
  userId: string,
  options: { limit?: number } = {},
): Promise<NotificationView[]> {
  const result = await db
    .from('notifications')
    .select('id, kind, tone, title, body, href, occurrences, occurred_at, read_at')
    .eq('user_id', userId)
    .order('occurred_at', { ascending: false })
    .limit(Math.min(Math.max(options.limit ?? DEFAULT_LIMIT, 1), 200));

  if (result.error) {
    throw new Error(
      `No se pudieron leer tus avisos: ${result.error.message}. Suele ser una migración sin aplicar en esta base de datos.`,
    );
  }
  return ((result.data ?? []) as Row[]).map(toView);
}

/**
 * Cuántos avisos sin leer tiene esta persona. Cero si la base no quiere decirlo.
 *
 * La excepción argumentada arriba: esto pinta el punto de la campana en todas
 * las pantallas del producto.
 */
export async function countUnread(db: SupabaseClient, userId: string): Promise<number> {
  try {
    const result = await db
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .is('read_at', null);
    if (result.error) {
      logger.warn('notifications: no se pudo contar lo no leído', {
        error: result.error.message,
      });
      return 0;
    }
    return result.count ?? 0;
  } catch (err) {
    logger.warn('notifications: no se pudo contar lo no leído', {
      error: (err as Error).message,
    });
    return 0;
  }
}

/**
 * Marca como leídos los avisos que se nombran, si son de quien los nombra.
 *
 * `.is('read_at', null)` no es una optimización: sin él, volver a marcar algo ya
 * leído le movería la hora de lectura, y esa hora es lo único que distingue
 * «esto lo vi la semana pasada» de «esto acaba de aparecer».
 *
 * @returns cuántos cambiaron de estado.
 */
export async function markRead(db: SupabaseClient, userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await db
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .in('id', ids)
    .is('read_at', null)
    .select('id');
  if (result.error) {
    throw new Error(`No se pudo marcar el aviso como leído: ${result.error.message}`);
  }
  return (result.data as Array<{ id: string }> | null)?.length ?? 0;
}

/** Marca toda la bandeja de esta persona. De nadie más. */
export async function markAllRead(db: SupabaseClient, userId: string): Promise<number> {
  const result = await db
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('read_at', null)
    .select('id');
  if (result.error) {
    throw new Error(`No se pudieron marcar los avisos como leídos: ${result.error.message}`);
  }
  return (result.data as Array<{ id: string }> | null)?.length ?? 0;
}
