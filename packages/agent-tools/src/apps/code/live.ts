import type { SupabaseClient } from '@supabase/supabase-js';
import { getTrackerBySlug } from '../../trackers/store';
import { type RowAccess, rowAccessFor } from '../permissions';
import type { AppAccess } from '../store';

/**
 * EL CANAL EN VIVO, LADO SERVIDOR (apps con código).
 *
 * `GET /api/apps/<app>/live?tables=a,b` abre un flujo SSE y cada ~2 s pregunta una HUELLA barata
 * por tabla: `cuántas filas | la última updated_at`, con el índice
 * `(organization_id, tracker_id, updated_at desc)`. Solo cuando la huella cambia se avisa. Un
 * borrado cambia la cuenta; una edición, la fecha; no existe borrado lógico en `tracker_rows`.
 *
 * El permiso es el de `tables.query`: una tabla que el rol no lee no se puede mirar (ni siquiera
 * para saber SI cambia), y la huella se calcula con el MISMO filtro de alcance de quien mira
 * (`own`, `equals`): lo que no ve no mueve su huella.
 */

/** Cuánto vale una huella calculada para no repetirla por cada conexión abierta. */
export const FINGERPRINT_TTL_MS = 1_500;
export const LIVE_TABLES_MAX = 12;

export interface LiveTable {
  /** El nombre con que la pantalla pidió la tabla (así se le avisa). */
  slug: string;
  trackerId: string;
  scope: RowAccess;
}

/** `?tables=a,b,a` → lista limpia, sin repetir, con tope. */
export function parseLiveTables(raw: string | null | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const slug = part.trim();
    if (!slug || slug.length > 80 || out.includes(slug)) continue;
    out.push(slug);
    if (out.length >= LIVE_TABLES_MAX) break;
  }
  return out;
}

/** La huella: cuenta y última modificación. */
export function fingerprintOf(count: number, maxUpdatedAt: string | null): string {
  return `${count}|${maxUpdatedAt ?? ''}`;
}

/** Qué tablas cambiaron entre dos tomas (las nuevas no cuentan: la primera toma solo fija la base). */
export function changedTables(
  prev: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const [slug, fp] of next) {
    const before = prev.get(slug);
    if (before !== undefined && before !== fp) out.push(slug);
  }
  return out;
}

/**
 * Resuelve cuáles de las tablas pedidas puede LEER quien mira. Las que no (sin permiso o que no
 * existen) vuelven en `denied` para avisárselo a la pantalla; nunca se confirma si tienen filas.
 */
export async function resolveLiveTables(
  db: SupabaseClient,
  access: AppAccess,
  slugs: string[],
): Promise<{ tables: LiveTable[]; denied: string[] }> {
  const tables: LiveTable[] = [];
  const denied: string[] = [];
  for (const slug of slugs) {
    const scope = rowAccessFor(access.role, access.user, slug);
    if (scope.kind === 'none') {
      denied.push(slug);
      continue;
    }
    const tracker = await getTrackerBySlug(db, slug);
    if (!tracker) {
      denied.push(slug);
      continue;
    }
    tables.push({ slug, trackerId: tracker.id, scope });
  }
  return { tables, denied };
}

const memo = new Map<string, { at: number; value: Promise<string> }>();

/** Comparte la huella entre conexiones: misma tabla y mismo alcance dentro del TTL = una consulta. */
export function memoFingerprint(
  key: string,
  now: number,
  compute: () => Promise<string>,
  ttl = FINGERPRINT_TTL_MS,
): Promise<string> {
  const hit = memo.get(key);
  if (hit && now - hit.at < ttl) return hit.value;
  const value = compute();
  memo.set(key, { at: now, value });
  // Si falla, que el siguiente intento no herede el error.
  value.catch(() => {
    if (memo.get(key)?.value === value) memo.delete(key);
  });
  if (memo.size > 500) {
    for (const [k, v] of memo) if (now - v.at >= ttl) memo.delete(k);
  }
  return value;
}

/** Solo para pruebas. */
export function clearFingerprintMemo(): void {
  memo.clear();
}

function scopeKey(scope: RowAccess): string {
  switch (scope.kind) {
    case 'all':
      return 'all';
    case 'own':
      return `own:${scope.external ? 'x' : 'm'}:${scope.userId}`;
    case 'equals':
      return `eq:${scope.field}:${scope.value ?? ''}`;
    default:
      return 'none';
  }
}

/** Una consulta por tabla: la cuenta y la fila más reciente, con el alcance de quien mira. */
export async function readFingerprint(
  db: SupabaseClient,
  table: LiveTable,
  now: number = Date.now(),
): Promise<string> {
  const { scope } = table;
  if (scope.kind === 'none' || (scope.kind === 'equals' && scope.value === null))
    return fingerprintOf(0, null);
  return memoFingerprint(`${table.trackerId}|${scopeKey(scope)}`, now, async () => {
    let query = db
      .from('tracker_rows')
      .select('updated_at', { count: 'exact' })
      .eq('tracker_id', table.trackerId);
    if (scope.kind === 'own')
      query = query.eq(scope.external ? 'created_by_app_user' : 'created_by', scope.userId);
    if (scope.kind === 'equals') query = query.eq(`values->>${scope.field}`, scope.value as string);
    const { data, count, error } = await query.order('updated_at', { ascending: false }).limit(1);
    if (error) throw error;
    const first = (data as Array<{ updated_at: string }> | null)?.[0];
    return fingerprintOf(count ?? 0, first?.updated_at ?? null);
  });
}
